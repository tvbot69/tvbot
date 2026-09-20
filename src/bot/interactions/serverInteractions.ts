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
import { TtlStore } from '@bot/services/ttlStore';

export interface CachedServerRanking {
  type: ServerRankingType;
  guildId: string;
  serverName: string;
  settings: GuildRankingSettings;
  artistFilter?: string | null;
  accentColor?: number | null;
  expiresAt: number;
}

const DATE_KEYS = ['startDateTime', 'endDateTime', 'billboardStartDateTime', 'billboardEndDateTime'] as const;

// Dual-layer session store (memory + Redis mirror) so ranking pagination
// survives restarts. Dates are revived after the JSON round-trip.
const serverRankingStore = new TtlStore<CachedServerRanking>(
  'session:server-ranking:',
  30 * 60,
  (value) => {
    const settings = { ...(value.settings as unknown as Record<string, unknown>) };
    for (const key of DATE_KEYS) {
      const raw = settings[key];
      if (typeof raw === 'string' && raw) settings[key] = new Date(raw);
    }
    return { ...value, settings: settings as unknown as GuildRankingSettings };
  },
);

export function storeServerRankingQuery(
  cacheKey: string,
  data: Omit<CachedServerRanking, 'expiresAt'>,
): void {
  serverRankingStore.set(cacheKey, {
    ...data,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
}

export function getCachedServerRankingQuery(cacheKey: string): Promise<CachedServerRanking | undefined> {
  return serverRankingStore.get(cacheKey);
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
    let rankingType: ServerRankingType;
    let cacheKey: string;
    let pageNum: number;
    let callerDiscordUserId: string;

    if (parts.length >= 7) {
      // server:page:{action}:{type}:{cacheKey}:{page}:{callerDiscordUserId}
      rankingType = parts[3] as ServerRankingType;
      cacheKey = parts[4]!;
      pageNum = parseInt(parts[5]!, 10);
      callerDiscordUserId = parts[6]!;
    } else if (parts.length === 6) {
      // server:page:{type}:{cacheKey}:{page}:{callerDiscordUserId}
      rankingType = parts[2] as ServerRankingType;
      cacheKey = parts[3]!;
      pageNum = parseInt(parts[4]!, 10);
      callerDiscordUserId = parts[5]!;
    } else {
      return;
    }

    if (interaction.user.id !== callerDiscordUserId) {
      await interaction.reply({
        content: 'Only the user who initiated the command can interact with these controls.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cached = await getCachedServerRankingQuery(cacheKey);
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
