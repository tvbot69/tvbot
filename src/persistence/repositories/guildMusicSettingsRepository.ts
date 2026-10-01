import { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logging/logger';

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
    // CORRECT AS IS, and it is ARGUMENT COERCION, not a data source - identical
    // reasoning to `safeBigInt` in crownRepository and `parseGuildId` in
    // genreService. A malformed guild id is a caller bug; calling it a database
    // outage would point the operator at the wrong system entirely, and `null`
    // is the honest answer: no such guild, so no settings to write.
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
      // CORRECT AS IS on the swallow - a WRITE path, so this is the shape the
      // phase warns about, and the reason it is still right is upstream of here.
      // `queueService.saveSettings` updates its in-memory map BEFORE calling this,
      // and that map is what every reader uses (`getSettings` / `is247` /
      // `toggleKaraoke`). A failed write therefore costs durability across a
      // restart and nothing else: the value the user was told is still the value
      // the bot is acting on this session, and the next write for that guild
      // re-persists the whole partial. Raising here would propagate into a
      // synchronous in-memory mutation that has already happened, so the command
      // would report failure for a setting that is in fact applied.
      //
      // DEBUG rather than nothing, rather than WARN: a user changing their own
      // volume is a once-a-session event, and the failure is invisible to them
      // by design. That said, the failure itself is what the operator needs, and
      // `err` is the only record of it - which is why this is not a bare
      // `catch {}`.
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
