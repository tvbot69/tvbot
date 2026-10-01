import type { PrismaClient } from '@prisma/client';
import type { IWhoKnowsRepository, WhoKnowsDbRow } from '@domain/interfaces/ports/iwhoKnowsRepository';

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
    // One row per user: SUM across case-variant duplicate rows ("Mac DeMarco"
    // vs "mac demarco"), otherwise a user with split rows ranks twice.
    const raw = await this.prisma.$queryRaw<RawWhoKnowsRow[]>`
      SELECT ua.user_id AS "userId", SUM(ua.playcount)::bigint AS "playcount"
      FROM user_artists AS ua
      WHERE UPPER(ua.name) = UPPER(${artistName})
      AND ua.user_id = ANY(SELECT user_id FROM guild_users WHERE guild_id = ${BigInt(guildId)})
      AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
      GROUP BY ua.user_id
      ORDER BY SUM(ua.playcount) DESC;
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
      AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ub.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
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
      AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ut.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
      ORDER BY ut.playcount DESC;
    `;

    return raw.map((r) => ({
      userId: Number(r.userId),
      playcount: Number(r.playcount),
    }));
  }

  /**
   * The three friend queries carry the SAME `NOT EXISTS (... abuse_flags ...)`
   * clause as the three indexed ones, and they must keep carrying it: without it
   * an account banned for abuse vanished from the guild leaderboard and still
   * appeared on the caller's personal "your friends also listen to this" list,
   * which is the same moderation decision answered two ways from two queries
   * about the same user. The friend list is personal, so it is not
   * `guild_users`-scoped — but "personal" is not "exempt".
   */
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
        AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
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
        AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ub.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
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
        AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ut.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
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
