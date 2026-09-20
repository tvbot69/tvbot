import { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logger';

export interface GuildMusicPrefs {
  stay247: boolean;
  volume: number;
  loopMode: string;
  autoplay: boolean;
  filters: string[];
}

export const DEFAULT_MUSIC_PREFS: GuildMusicPrefs = {
  stay247: false,
  volume: 100,
  loopMode: 'off',
  autoplay: false,
  filters: [],
};

const safeBigInt = (id: string): bigint | null => {
  if (!id || !/^\d+$/.test(id)) return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
};

/**
 * Durable per-guild music prefs + bot-scrobbling opt-ins. Services mirror
 * these into memory at boot and write through on change, so deploys stop
 * wiping 24/7 mode, volume, loops, filters, and opt-ins.
 */
export class GuildMusicSettingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async getAllSettings(): Promise<Array<{ guildId: string } & GuildMusicPrefs>> {
    try {
      const rows = await this.prisma.guildMusicSettings.findMany();
      return rows.map((r) => ({
        guildId: r.guildId.toString(),
        stay247: r.stay247,
        volume: r.volume,
        loopMode: r.loopMode,
        autoplay: r.autoplay,
        filters: [...r.filters],
      }));
    } catch (err) {
      Logger.debug({ err }, 'Failed to load guild music settings');
      return [];
    }
  }

  public async saveSettings(guildId: string, partial: Partial<GuildMusicPrefs>): Promise<void> {
    const gid = safeBigInt(guildId);
    if (!gid) return;
    try {
      await this.prisma.guildMusicSettings.upsert({
        where: { guildId: gid },
        update: {
          ...(partial.stay247 !== undefined ? { stay247: partial.stay247 } : {}),
          ...(partial.volume !== undefined ? { volume: partial.volume } : {}),
          ...(partial.loopMode !== undefined ? { loopMode: partial.loopMode } : {}),
          ...(partial.autoplay !== undefined ? { autoplay: partial.autoplay } : {}),
          ...(partial.filters !== undefined ? { filters: partial.filters } : {}),
        },
        create: {
          guildId: gid,
          stay247: partial.stay247 ?? false,
          volume: partial.volume ?? 100,
          loopMode: partial.loopMode ?? 'off',
          autoplay: partial.autoplay ?? false,
          filters: partial.filters ?? [],
        },
      });
    } catch (err) {
      Logger.debug({ err, guildId }, 'Failed to save guild music settings');
    }
  }

  public async getOptedInDiscordIds(): Promise<string[]> {
    try {
      const rows = await this.prisma.botScrobbleOptIn.findMany({ select: { discordUserId: true } });
      return rows.map((r) => r.discordUserId.toString());
    } catch (err) {
      Logger.debug({ err }, 'Failed to load scrobble opt-ins');
      return [];
    }
  }

  public async setOptIn(discordUserId: string, enabled: boolean): Promise<void> {
    const id = safeBigInt(discordUserId);
    if (!id) return;
    try {
      if (enabled) {
        await this.prisma.botScrobbleOptIn.upsert({
          where: { discordUserId: id },
          update: {},
          create: { discordUserId: id },
        });
      } else {
        await this.prisma.botScrobbleOptIn.deleteMany({ where: { discordUserId: id } });
      }
    } catch (err) {
      Logger.debug({ err, discordUserId }, 'Failed to persist scrobble opt-in');
    }
  }
}
