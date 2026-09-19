import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import type { UserCrownDto, CrownViewType } from '@domain/models/crownModels';

@injectable()
export class CrownRepository {
  constructor(@inject(PrismaClient) private readonly prisma: PrismaClient) {}

  private safeBigInt(id: string): bigint | null {
    if (!id || !/^\d+$/.test(id)) return null;
    try {
      return BigInt(id);
    } catch {
      return null;
    }
  }

  public async getCurrentCrown(guildId: string, artistName: string): Promise<UserCrownDto | null> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return null;

    const rows = await this.prisma.$queryRaw<UserCrownDto[]>`
      SELECT 
        c.crown_id as "crownId",
        c.guild_id::text as "guildId",
        c.user_id as "userId",
        c.artist_name as "artistName",
        c.current_playcount as "currentPlaycount",
        c.start_playcount as "startPlaycount",
        c.created as "created",
        c.modified as "modified",
        c.active as "active",
        c.seeded_crown as "seededCrown",
        u.user_name_last_fm as "userNameLastFm",
        u.discord_user_id::text as "discordUserId"
      FROM user_crowns c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.guild_id = ${gid}
        AND c.active = true
        AND UPPER(c.artist_name) = UPPER(${artistName})
      LIMIT 1
    `;

    return rows.length > 0 ? (rows[0] as UserCrownDto) : null;
  }

  public async deactivateCrownsForUser(userId: number): Promise<number> {
    const res = await this.prisma.userCrown.updateMany({
      where: { userId, active: true },
      data: { active: false, modified: new Date() },
    });
    return res.count;
  }

  public async deactivateCrown(crownId: number): Promise<void> {
    await this.prisma.userCrown.update({
      where: { crownId },
      data: {
        active: false,
        modified: new Date(),
      },
    });
  }

  public async createCrown(data: {
    guildId: string;
    userId: number;
    artistName: string;
    startPlaycount: number;
    currentPlaycount: number;
    seededCrown?: boolean;
  }): Promise<UserCrownDto> {
    const created = await this.prisma.userCrown.create({
      data: {
        guildId: BigInt(data.guildId),
        userId: data.userId,
        artistName: data.artistName,
        startPlaycount: data.startPlaycount,
        currentPlaycount: data.currentPlaycount,
        active: true,
        seededCrown: data.seededCrown ?? false,
      },
      include: {
        user: true,
      },
    });

    return {
      crownId: created.crownId,
      guildId: created.guildId.toString(),
      userId: created.userId,
      artistName: created.artistName,
      currentPlaycount: created.currentPlaycount,
      startPlaycount: created.startPlaycount,
      created: created.created,
      modified: created.modified,
      active: created.active,
      seededCrown: created.seededCrown,
      userNameLastFm: created.user.userNameLastFm,
      discordUserId: created.user.discordUserId.toString(),
    };
  }

  /**
   * Atomically steals a crown: only deactivates + recreates when the expected
   * holder row is still active. Returns null when a concurrent steal got there
   * first — the caller must re-read instead of creating a second active crown.
   */
  public async replaceCrown(
    currentCrownId: number,
    data: {
      guildId: string;
      userId: number;
      artistName: string;
      startPlaycount: number;
      currentPlaycount: number;
      seededCrown?: boolean;
    },
  ): Promise<UserCrownDto | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.userCrown.findUnique({
          where: { crownId: currentCrownId },
          select: { active: true },
        });
        if (!current?.active) return null;
        await tx.userCrown.update({
          where: { crownId: currentCrownId },
          data: { active: false, modified: new Date() },
        });
        const created = await tx.userCrown.create({
          data: {
            guildId: BigInt(data.guildId),
            userId: data.userId,
            artistName: data.artistName,
            startPlaycount: data.startPlaycount,
            currentPlaycount: data.currentPlaycount,
            active: true,
            seededCrown: data.seededCrown ?? false,
          },
          include: { user: true },
        });
        return {
          crownId: created.crownId,
          guildId: created.guildId.toString(),
          userId: created.userId,
          artistName: created.artistName,
          currentPlaycount: created.currentPlaycount,
          startPlaycount: created.startPlaycount,
          created: created.created,
          modified: created.modified,
          active: created.active,
          seededCrown: created.seededCrown,
          userNameLastFm: created.user.userNameLastFm,
          discordUserId: created.user.discordUserId.toString(),
        };
      },
      { timeout: 15000, maxWait: 5000 },
    );
  }

  public async updateCrownPlaycount(crownId: number, playcount: number): Promise<void> {
    await this.prisma.userCrown.update({
      where: { crownId },
      data: {
        currentPlaycount: playcount,
        modified: new Date(),
      },
    });
  }

  public async getUserCrowns(
    guildId: string,
    userId: number,
    viewType: CrownViewType = 'Playcount',
  ): Promise<UserCrownDto[]> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return [];

    let activeFilter = true;

    if (viewType === 'Stolen') {
      activeFilter = false;
    }

    const rows = await this.prisma.$queryRaw<UserCrownDto[]>`
      SELECT 
        c.crown_id as "crownId",
        c.guild_id::text as "guildId",
        c.user_id as "userId",
        c.artist_name as "artistName",
        c.current_playcount as "currentPlaycount",
        c.start_playcount as "startPlaycount",
        c.created as "created",
        c.modified as "modified",
        c.active as "active",
        c.seeded_crown as "seededCrown",
        u.user_name_last_fm as "userNameLastFm",
        u.discord_user_id::text as "discordUserId"
      FROM user_crowns c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.guild_id = ${gid}
        AND c.user_id = ${userId}
        AND c.active = ${activeFilter}
      ORDER BY 
        CASE WHEN ${viewType === 'Recent'} THEN c.created END DESC,
        CASE WHEN ${viewType === 'Stolen'} THEN c.modified END DESC,
        CASE WHEN ${viewType === 'Playcount'} THEN c.current_playcount END DESC,
        c.created ASC
    `;

    return rows as UserCrownDto[];
  }

  public async getTopCrownHoldersInGuild(guildId: string): Promise<Array<{ userId: number; crownCount: number; userNameLastFm: string; discordUserId: string }>> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return [];

    const rows = await this.prisma.$queryRaw<Array<{ userId: number; crownCount: number; userNameLastFm: string; discordUserId: string }>>`
      SELECT
        c.user_id as "userId",
        COUNT(*)::int as "crownCount",
        u.user_name_last_fm as "userNameLastFm",
        u.discord_user_id::text as "discordUserId"
      FROM user_crowns c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.guild_id = ${gid}
        AND c.active = true
      GROUP BY c.user_id, u.user_name_last_fm, u.discord_user_id
      ORDER BY "crownCount" DESC
    `;
    return rows;
  }

  public async getTotalActiveCrownsInGuild(guildId: string): Promise<number> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return 0;

    const count = await this.prisma.userCrown.count({
      where: {
        guildId: gid,
        active: true,
      },
    });
    return count;
  }

  public async getCrownHistoryForArtist(guildId: string, artistName: string, limit: number = 10): Promise<UserCrownDto[]> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return [];

    const rows = await this.prisma.$queryRaw<UserCrownDto[]>`
      SELECT 
        c.crown_id as "crownId",
        c.guild_id::text as "guildId",
        c.user_id as "userId",
        c.artist_name as "artistName",
        c.current_playcount as "currentPlaycount",
        c.start_playcount as "startPlaycount",
        c.created as "created",
        c.modified as "modified",
        c.active as "active",
        c.seeded_crown as "seededCrown",
        u.user_name_last_fm as "userNameLastFm",
        u.discord_user_id::text as "discordUserId"
      FROM user_crowns c
      JOIN users u ON u.user_id = c.user_id
      WHERE c.guild_id = ${gid}
        AND UPPER(c.artist_name) = UPPER(${artistName})
      ORDER BY c.created DESC
      LIMIT ${limit}
    `;
    return rows as UserCrownDto[];
  }

  public async seedCrownsForGuild(
    guildId: string,
    minPlaycount: number = 30,
  ): Promise<number> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return 0;

    // Delete previous seeded crowns
    await this.prisma.userCrown.deleteMany({
      where: {
        guildId: gid,
        seededCrown: true,
      },
    });

    // Find top distinct artist listeners for this guild
    const topArtists = await this.prisma.$queryRaw<{ userId: number; artistName: string; playcount: number }[]>`
      SELECT DISTINCT ON (LOWER(ua.name))
        ua.user_id as "userId",
        ua.name as "artistName",
        ua.playcount as "playcount"
      FROM user_artists ua
      JOIN guild_users gu ON gu.user_id = ua.user_id
      WHERE gu.guild_id = ${gid}
        AND ua.playcount >= ${minPlaycount}
        AND gu.blocked_from_crowns = false
        AND gu.who_knows_banned = false
      ORDER BY LOWER(ua.name), ua.playcount DESC
    `;

    let inserted = 0;
    for (const item of topArtists) {
      // Check if there is an active non-seeded crown
      const existing = await this.prisma.userCrown.findFirst({
        where: {
          guildId: gid,
          active: true,
          artistName: {
            equals: item.artistName,
            mode: 'insensitive',
          },
        },
      });

      if (!existing) {
        await this.prisma.userCrown.create({
          data: {
            guildId: gid,
            userId: item.userId,
            artistName: item.artistName,
            startPlaycount: item.playcount,
            currentPlaycount: item.playcount,
            active: true,
            seededCrown: true,
          },
        });
        inserted++;
      }
    }

    return inserted;
  }

  public async killCrown(guildId: string, artistName: string): Promise<boolean> {
    const res = await this.prisma.userCrown.updateMany({
      where: {
        guildId: BigInt(guildId),
        active: true,
        artistName: {
          equals: artistName,
          mode: 'insensitive',
        },
      },
      data: {
        active: false,
        modified: new Date(),
      },
    });
    return res.count > 0;
  }

  public async removeUserCrowns(guildId: string, userId: number): Promise<number> {
    const res = await this.prisma.userCrown.updateMany({
      where: {
        guildId: BigInt(guildId),
        userId,
        active: true,
      },
      data: {
        active: false,
        modified: new Date(),
      },
    });
    return res.count;
  }

  public async setCrownBlock(guildId: string, userId: number, blocked: boolean): Promise<void> {
    const gid = BigInt(guildId);
    await this.prisma.guildUser.upsert({
      where: {
        guildId_userId: { guildId: gid, userId },
      },
      update: {
        blockedFromCrowns: blocked,
      },
      create: {
        guildId: gid,
        userId,
        blockedFromCrowns: blocked,
      },
    });

    if (blocked) {
      await this.removeUserCrowns(guildId, userId);
    }
  }

  public async getBlockedCrownUsers(guildId: string): Promise<{ userId: number; userNameLastFm: string; discordUserId: string }[]> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return [];

    const rows = await this.prisma.$queryRaw<{ userId: number; userNameLastFm: string; discordUserId: string }[]>`
      SELECT 
        gu.user_id as "userId",
        u.user_name_last_fm as "userNameLastFm",
        u.discord_user_id::text as "discordUserId"
      FROM guild_users gu
      JOIN users u ON u.user_id = gu.user_id
      WHERE gu.guild_id = ${gid}
        AND gu.blocked_from_crowns = true
      ORDER BY u.user_name_last_fm ASC
    `;
    return rows;
  }

  public async setCrownRole(guildId: string, roleId: string | null): Promise<void> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return;

    const validRoleId = roleId && /^\d+$/.test(roleId) ? BigInt(roleId) : null;
    const roles = validRoleId ? [validRoleId] : [];
    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { crownRoles: roles },
    });
  }

  public async getCrownRoles(guildId: string): Promise<string[]> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return [];

    const guild = await this.prisma.guild.findUnique({
      where: { guildId: gid },
      select: { crownRoles: true },
    });
    return guild?.crownRoles?.map((r) => r.toString()) ?? [];
  }

  public async killAllCrowns(guildId: string): Promise<number> {
    const gid = this.safeBigInt(guildId);
    if (!gid) return 0;

    const res = await this.prisma.userCrown.updateMany({
      where: {
        guildId: gid,
        active: true,
      },
      data: {
        active: false,
        modified: new Date(),
      },
    });
    return res.count;
  }
}
