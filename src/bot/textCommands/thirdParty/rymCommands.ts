import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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

const ARTIST_USAGE = (prefix: string) =>
  `Usage: \`${prefix}rym artist <artist-slug>\` (e.g. \`${prefix}rym artist radiohead\`)`;

const RELEASE_USAGE = (prefix: string) =>
  `Usage: \`${prefix}rym release <artist/title>\` (e.g. \`${prefix}rym release pixies/surfer-rosa\`)`;

export const artistSlugFromInput = (input: string): string => {
  const trimmed = input.trim();
  const match = /\/artist\/([^/]+)/.exec(trimmed);
  if (match) {
    return match[1] ?? '';
  }
  if (/^https?:\/\//.test(trimmed)) {
    const segments = trimmed.split('/').filter((s) => s.length > 0);
    return segments[segments.length - 1] ?? '';
  }
  return trimmed.replace(/\/+$/, '');
};

export const releaseSlugFromInput = (input: string): { slug: string; releaseType?: string } => {
  const trimmed = input.trim();
  const match = /\/release\/([^/]+)\/([^/]+)\/([^/]+)/.exec(trimmed);
  if (match) {
    return { slug: `${match[2]}/${match[3]}`, releaseType: match[1] };
  }
  return { slug: trimmed.replace(/\/+$/, '') };
};

const rymError = (err: unknown): ResponseModel =>
  GenericEmbedService.buildCommandErrorResponse(
    CommandResponse.Error,
    err instanceof RymOriginBlockError
      ? 'Rate Your Music origin-blocked this page (503). Try again later, or use chart/artist pages.'
      : `Rate Your Music request failed: ${errorMessage(err) || 'Unknown error'}`,
  );

@injectable()
export class RymCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(RymTransport) private readonly rymTransport: RymTransport,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'rym',
        aliases: [],
        executeAsync: (ctx, args) => this.rymAsync(ctx, args),
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

  public async rymAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const sub = (args[0] ?? 'chart').toLowerCase();
    const rest = args.slice(1).join(' ').trim();
    const accentColor = await this.getAccentColor(ctx);

    try {
      if (sub === 'chart' || sub === 'top') {
        const period = rest.length > 0 ? rest : 'all-time';
        const stubs = await getChart(this.rymTransport, `/charts/top/album/${period}/`);
        return RymBuilders.buildChartResponse(`Top albums — ${period}`, stubs, accentColor);
      }

      if (sub === 'artist') {
        if (!rest) {
          return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, ARTIST_USAGE(ctx.prefix));
        }
        const slug = artistSlugFromInput(rest);
        const artist = await getArtist(this.rymTransport, slug);
        return RymBuilders.buildArtistResponse(artist, accentColor);
      }

      if (sub === 'release' || sub === 'album') {
        if (!rest) {
          return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, RELEASE_USAGE(ctx.prefix));
        }
        const { slug, releaseType } = releaseSlugFromInput(rest);
        const release = await getRelease(this.rymTransport, slug, releaseType ?? 'album');
        return RymBuilders.buildReleaseResponse(release, accentColor);
      }

      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Unknown subcommand \`${sub}\`. Try \`${ctx.prefix}rym chart|artist|release\`.`,
      );
    } catch (err) {
      return rymError(err);
    }
  }
}
