import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import { UserService } from '@bot/services/user/userService';
import { PrefixService } from '@bot/services/user/prefixService';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import { RymTransport } from '@rateyourmusic/api/rymClient';
import { RateMyCommands } from '@bot/textCommands/thirdParty/rateMyCommands';

@injectable()
export class RateMySlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(RymTransport) private readonly rymTransport: RymTransport,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(ArtworkService) private readonly artworkService: ArtworkService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    const text = new RateMyCommands(userService, rymTransport, prefixService, lastFmRepository, artworkService, colorService);
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('rma')
          .setDescription('Rate Your Music rating for an album (defaults to your last scrobble)')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('artist/title or Artist - Album').setRequired(false),
          ),
        executeAsync: async (ctx) => text.albumAsync(ctx, ctx.interaction?.options.getString('query') ?? ''),
      },
      {
        data: new SlashCommandBuilder()
          .setName('rmt')
          .setDescription('Rate Your Music rating for the album of a track (defaults to your last scrobble)')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('artist/title or Artist - Album').setRequired(false),
          ),
        executeAsync: async (ctx) => text.trackAsync(ctx, ctx.interaction?.options.getString('query') ?? ''),
      },
      {
        data: new SlashCommandBuilder()
          .setName('rm')
          .setDescription('Rate Your Music artist page and discography (defaults to your last scrobble)')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Artist name').setRequired(false),
          ),
        executeAsync: async (ctx) => text.artistAsync(ctx, ctx.interaction?.options.getString('query') ?? ''),
      },
      {
        data: new SlashCommandBuilder()
          .setName('rmc')
          .setDescription('Top Rate Your Music album chart by period (all-time, 2025, 1990s, ...)')
          .addStringOption((opt) =>
            opt.setName('period').setDescription('Chart period, e.g. 2025 or 1990s').setRequired(false),
          ),
        executeAsync: async (ctx) => text.chartAsync(ctx, ctx.interaction?.options.getString('period') ?? ''),
      },
    ];
  }
}
