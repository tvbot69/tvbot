import { ButtonInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import {
  GuildRankingService,
  GuildRankingSettings,
  GuildRankingItem,
} from '@bot/services/guildRankingService';
import {
  ServerBuilders,
  ServerRankingType,
} from '@bot/builders/serverBuilders';
import { ColorService } from '@bot/services/colorService';

export interface CachedServerRanking {
  type: ServerRankingType;
  guildId: string;
  serverName: string;
  settings: GuildRankingSettings;
  artistFilter?: string | null;
  accentColor?: number | null;
  expiresAt: number;
}

const serverRankingCache = new Map<string, CachedServerRanking>();

export function storeServerRankingQuery(
  cacheKey: string,
  data: Omit<CachedServerRanking, 'expiresAt'>,
): void {
  serverRankingCache.set(cacheKey, {
    ...data,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  if (serverRankingCache.size > 200) {
    const now = Date.now();
    for (const [key, val] of serverRankingCache.entries()) {
      if (val.expiresAt < now) serverRankingCache.delete(key);
    }
  }
}

export function getCachedServerRankingQuery(cacheKey: string): CachedServerRanking | undefined {
  const cached = serverRankingCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    serverRankingCache.delete(cacheKey);
    return undefined;
  }
  return cached;
}

@injectable()
export class ServerInteractions {
  constructor(
    @inject(GuildRankingService) private readonly guildRankingService: GuildRankingService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('server:page:')) {
      return;
    }

    const parts = customId.split(':');
    // server:page:{type}:{cacheKey}:{page}:{callerDiscordUserId}
    if (parts.length < 6) return;

    const rankingType = parts[2] as ServerRankingType;
    const cacheKey = parts[3]!;
    const pageNum = parseInt(parts[4]!, 10);
    const callerDiscordUserId = parts[5]!;

    if (interaction.user.id !== callerDiscordUserId) {
      await interaction.reply({
        content: 'Only the user who initiated the command can interact with these controls.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cached = getCachedServerRankingQuery(cacheKey);
    if (!cached) {
      await interaction.reply({
        content: 'This server chart interaction has expired. Please run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let items: GuildRankingItem[] = [];
    let previousItems: GuildRankingItem[] | null = null;

    if (rankingType === 'artists') {
      items = await this.guildRankingService.getGuildTopArtists(cached.guildId, cached.settings);
      if (cached.settings.billboardStartDateTime) {
        previousItems = await this.guildRankingService.getGuildTopArtists(cached.guildId, {
          ...cached.settings,
          startDateTime: cached.settings.billboardStartDateTime,
          endDateTime: cached.settings.billboardEndDateTime,
        });
      }
    } else if (rankingType === 'albums') {
      items = await this.guildRankingService.getGuildTopAlbums(
        cached.guildId,
        cached.settings,
        cached.artistFilter,
      );
      if (cached.settings.billboardStartDateTime) {
        previousItems = await this.guildRankingService.getGuildTopAlbums(
          cached.guildId,
          {
            ...cached.settings,
            startDateTime: cached.settings.billboardStartDateTime,
            endDateTime: cached.settings.billboardEndDateTime,
          },
          cached.artistFilter,
        );
      }
    } else if (rankingType === 'tracks') {
      items = await this.guildRankingService.getGuildTopTracks(
        cached.guildId,
        cached.settings,
        cached.artistFilter,
      );
      if (cached.settings.billboardStartDateTime) {
        previousItems = await this.guildRankingService.getGuildTopTracks(
          cached.guildId,
          {
            ...cached.settings,
            startDateTime: cached.settings.billboardStartDateTime,
            endDateTime: cached.settings.billboardEndDateTime,
          },
          cached.artistFilter,
        );
      }
    } else if (rankingType === 'genres') {
      items = await this.guildRankingService.getGuildTopGenres(cached.guildId, cached.settings);
      if (cached.settings.billboardStartDateTime) {
        previousItems = await this.guildRankingService.getGuildTopGenres(cached.guildId, {
          ...cached.settings,
          startDateTime: cached.settings.billboardStartDateTime,
          endDateTime: cached.settings.billboardEndDateTime,
        });
      }
    }

    const response = ServerBuilders.buildServerLeaderboardResponse({
      type: rankingType,
      serverName: cached.serverName,
      items,
      previousItems,
      settings: cached.settings,
      pageIndex: pageNum,
      cacheKey,
      callerDiscordUserId,
      accentColor: cached.accentColor,
      artistFilter: cached.artistFilter,
    });

    await interaction.update(response.toMessagePayload() as Parameters<typeof interaction.update>[0]);
  }
}
