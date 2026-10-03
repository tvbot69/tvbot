import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { PrefixService } from '@bot/services/user/prefixService';
import { ColorService } from '@bot/services/system/colorService';
import { RymTransport, RymOriginBlockError, getArtist, getChart, getRelease } from '@rateyourmusic/api/rymClient';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { RymBuilders } from '@bot/builders/rateyourmusic/rymBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import { errorMessage } from '@domain/errors/discordErrors';
import { artistSlugFromInput, releaseSlugFromInput } from '@bot/textCommands/thirdParty/rymCommands';

@injectable()
export class RymSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(RymTransport) private readonly rymTransport: RymTransport,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('rym')
          .setDescription('Rate Your Music: charts, artist pages, album ratings')
          .addSubcommand((sub) =>
            sub
              .setName('chart')
              .setDescription('Top album chart by period (all-time, 2023, 1990s, ...)')
              .addStringOption((opt) =>
                opt.setName('period').setDescription('all-time | year | decade').setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('artist')
              .setDescription('Artist info and discography')
              .addStringOption((opt) =>
                opt.setName('slug').setDescription('Artist slug or URL (e.g. radiohead)').setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('release')
              .setDescription('Album/release ratings, genres and tracklist')
              .addStringOption((opt) =>
                opt.setName('slug').setDescription('artist/title or RYM URL (e.g. pixies/surfer-rosa)').setRequired(true),
              )
              .addStringOption((opt) =>
                opt
                  .setName('type')
                  .setDescription('Release type')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Album', value: 'album' },
                    { name: 'EP', value: 'ep' },
                    { name: 'Single', value: 'single' },
                    { name: 'Compilation', value: 'comp' },
                  ),
              ),
          ),
        executeAsync: (ctx) => this.rymSlashAsync(ctx),
      },
    ];
  }

  private async getAccentColor(ctx: ContextModel): Promise<number> {
    if (this.colorService) {
      const color = await this.colorService.getAccentColorAsync(ctx.guildId);
      if (color) return color;
    }
    return DiscordConstants.SuccessColorGreen;
  }

  public async rymSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const sub = ctx.interaction?.options.getSubcommand() ?? 'chart';
    const accentColor = await this.getAccentColor(ctx);

    try {
      if (sub === 'chart') {
        const period = ctx.interaction?.options.getString('period') ?? 'all-time';
        const stubs = await getChart(this.rymTransport, `/charts/top/album/${period}/`);
        return RymBuilders.buildChartResponse(`Top albums — ${period}`, stubs, accentColor);
      }

      if (sub === 'artist') {
        const slug = artistSlugFromInput(ctx.interaction?.options.getString('slug') ?? '');
        if (!slug) {
          return GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            'Missing artist slug.',
          );
        }
        const artist = await getArtist(this.rymTransport, slug);
        return RymBuilders.buildArtistResponse(artist, accentColor);
      }

      if (sub === 'release') {
        const { slug, releaseType } = releaseSlugFromInput(ctx.interaction?.options.getString('slug') ?? '');
        const explicitType = ctx.interaction?.options.getString('type');
        if (!slug) {
          return GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            'Missing release slug.',
          );
        }
        const release = await getRelease(this.rymTransport, slug, explicitType ?? releaseType ?? 'album');
        return RymBuilders.buildReleaseResponse(release, accentColor);
      }

      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Unknown subcommand \`${sub}\`.`,
      );
    } catch (err) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        err instanceof RymOriginBlockError
          ? 'Rate Your Music origin-blocked this page (503). Try again later, or use chart/artist pages.'
          : `Rate Your Music request failed: ${errorMessage(err) || 'Unknown error'}`,
      );
    }
  }
}
