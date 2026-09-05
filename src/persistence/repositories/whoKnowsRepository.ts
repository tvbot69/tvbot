import type { PrismaClient } from '@prisma/client';
import type { IWhoKnowsRepository, WhoKnowsDbRow } from '@domain/interfaces/iwhoKnowsRepository';

interface RawWhoKnowsRow {
  userId: number;
  playcount: number;
  userNameLastFm?: string;
  discordName?: string;
}

export class WhoKnowsRepository implements IWhoKnowsRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getIndexedUsersForArtist(
    guildId: string,
    artistName: string,
  ): Promise<WhoKnowsDbRow[]> {
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT ua.user_id AS "userId", ua.playcount AS "playcount"
      FROM user_artists AS ua
      WHERE UPPER(ua.name) = UPPER(${artistName})
      AND ua.user_id = ANY(SELECT user_id FROM guild_users WHERE guild_id = ${BigInt(guildId)})
      ORDER BY ua.playcount DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
    }));
  }

  public async getIndexedUsersForAlbum(
    guildId: string,
    albumId: number,
  ): Promise<WhoKnowsDbRow[]> {
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT ub.user_id AS "userId", ub.playcount AS "playcount"
      FROM user_albums AS ub
      WHERE ub.album_id = ${albumId}
      AND ub.user_id = ANY(SELECT user_id FROM guild_users WHERE guild_id = ${BigInt(guildId)})
      ORDER BY ub.playcount DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
    }));
  }

  public async getIndexedUsersForTrack(
    guildId: string,
    trackId: number,
  ): Promise<WhoKnowsDbRow[]> {
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT ut.user_id AS "userId", ut.playcount AS "playcount"
      FROM user_tracks AS ut
      WHERE ut.track_id = ${trackId}
      AND ut.user_id = ANY(SELECT user_id FROM guild_users WHERE guild_id = ${BigInt(guildId)})
      ORDER BY ut.playcount DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
    }));
  }

  public async getFriendUsersForArtist(
    userId: number,
    artistName: string,
    _guildId?: string,
  ): Promise<WhoKnowsDbRow[]> {
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT *
      FROM (
        SELECT DISTINCT ON(UPPER(u.user_name_last_fm))
          ua.user_id AS "userId",
          ua.playcount AS "playcount",
          u.user_name_last_fm AS "userNameLastFm"
        FROM user_artists AS ua
        JOIN users AS u ON ua.user_id = u.user_id
        JOIN friends AS fr ON fr.friend_user_id = ua.user_id
        WHERE fr.user_id = ${userId}
        AND UPPER(ua.name) = UPPER(${artistName})
        ORDER BY UPPER(u.user_name_last_fm) DESC, ua.playcount DESC
      ) sub
      ORDER BY sub."playcount" DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
      userNameLastFm: r.userNameLastFm,
    }));
  }

  public async getFriendUsersForAlbum(
    userId: number,
    albumId: number,
    _guildId?: string,
  ): Promise<WhoKnowsDbRow[]> {
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT *
      FROM (
        SELECT DISTINCT ON(UPPER(u.user_name_last_fm))
          ub.user_id AS "userId",
          ub.playcount AS "playcount",
          u.user_name_last_fm AS "userNameLastFm"
        FROM user_albums AS ub
        JOIN users AS u ON ub.user_id = u.user_id
        JOIN friends AS fr ON fr.friend_user_id = ub.user_id
        WHERE fr.user_id = ${userId}
        AND ub.album_id = ${albumId}
        ORDER BY UPPER(u.user_name_last_fm) DESC, ub.playcount DESC
      ) sub
      ORDER BY sub."playcount" DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
      userNameLastFm: r.userNameLastFm,
    }));
  }

  public async getFriendUsersForTrack(
    userId: number,
    trackId: number,
    _guildId?: string,
  ): Promise<WhoKnowsDbRow[]> {
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT *
      FROM (
        SELECT DISTINCT ON(UPPER(u.user_name_last_fm))
          ut.user_id AS "userId",
          ut.playcount AS "playcount",
          u.user_name_last_fm AS "userNameLastFm"
        FROM user_tracks AS ut
        JOIN users AS u ON ut.user_id = u.user_id
        JOIN friends AS fr ON fr.friend_user_id = ut.user_id
        WHERE fr.user_id = ${userId}
        AND ut.track_id = ${trackId}
        ORDER BY UPPER(u.user_name_last_fm) DESC, ut.playcount DESC
      ) sub
      ORDER BY sub."playcount" DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
      userNameLastFm: r.userNameLastFm,
    }));
  }
}
