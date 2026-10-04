import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { PrefixService } from '@bot/services/user/prefixService';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import {
  RymTransport,
  RymOriginBlockError,
  getArtist,
  getRelease,
  getSong,
  getChart,
} from '@rateyourmusic/api/rymClient';
import { RymNotFoundError } from '@rateyourmusic/api/rymParsers';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { RymBuilders } from '@bot/builders/rateyourmusic/rymBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { errorMessage } from '@domain/errors/discordErrors';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

interface NowPlayingTriple {
  artist: string;
  album: string;
  track: string;
}

/** RYM slugs drop apostrophes/periods and collapse punctuation runs into one
 *  dash: `Yes I'm Changing` -> `yes-im-changing`, `Guns N' Roses` -> `guns-n-roses`. */
export const slugify = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[''’`]/g, '')
    .replace(/(\d)\.(\d)/g, '$1_$2')
    .replace(/\./g, '')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const releaseSlugFromTriple = (triple: NowPlayingTriple): string =>
  `${slugify(triple.artist)}/${slugify(triple.album)}`;

const parseSlugOrTitle = (input: string): { slug?: string; title?: string } => {
  const trimmed = input.trim();
  if (/^[^\s]+\/[^\s]+$/.test(trimmed)) {
    return { slug: trimmed.replace(/\/+$/, '') };
  }
  if (trimmed.includes(' - ')) {
    const [artist, ...rest] = trimmed.split(' - ');
    return { slug: `${slugify(artist ?? '')}/${slugify(rest.join(' - '))}` };
  }
  return { title: trimmed };
};

@injectable()
export class RateMyCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(RymTransport) private readonly rymTransport: RymTransport,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(ArtworkService) private readonly artworkService: ArtworkService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'rma',
        aliases: [],
        executeAsync: (ctx, args) => this.albumAsync(ctx, args.join(' ').trim()),
      },
      {
        name: 'rmt',
        aliases: [],
        executeAsync: (ctx, args) => this.trackAsync(ctx, args.join(' ').trim()),
      },
      {
        name: 'rm',
        aliases: [],
        executeAsync: (ctx, args) => this.artistAsync(ctx, args.join(' ').trim()),
      },
      {
        name: 'rmc',
        aliases: [],
        executeAsync: (ctx, args) => this.chartAsync(ctx, args.join(' ').trim()),
      },
    ];
  }

  private async getAccentColor(ctx: ContextModel, coverUrl?: string | null): Promise<number | undefined> {
    if (this.colorService && coverUrl) {
      const fromCover = await this.colorService.getColorFromImageUrl(coverUrl);
      if (fromCover) return fromCover;
    }
    if (this.colorService) {
      const fallback = await this.colorService.getAccentColorAsync(ctx.guildId);
      if (fallback) return fallback;
    }
    return undefined;
  }

  private async resolveFromLastfm(ctx: ContextModel, cmd: string): Promise<NowPlayingTriple | ResponseModel> {
    const user = await ensureLinkedUser(this.userService, ctx.discordUserId, { prefix: ctx.prefix });
    if ('commandResponse' in user) return user;

    try {
      const recents = await this.lastFmRepository.getUserRecentTracks(
        user.userNameLastFm,
        2,
        1,
        undefined,
        user.sessionKey ?? undefined,
      );
      const track = recents?.find((t) => t.nowPlaying) ?? recents?.[0];
      if (!track || (!track.artistName && !track.name && !track.albumName)) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `No recent tracks found for **${user.userNameLastFm}**. Pass a query (e.g. \`${ctx.prefix}${cmd} Artist - Album\`).`,
        );
      }
      return {
        artist: track.artistName ?? '',
        album: track.albumName ?? '',
        track: track.name ?? '',
      };
    } catch (err) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to read your Last.fm recents: ${errorMessage(err) || 'Unknown error'}.`,
      );
    }
  }

  private rymError(err: unknown): ResponseModel {
    if (err instanceof RymNotFoundError) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Rate Your Music has no page for that. Check the slug — RYM titles can differ from Last.fm (e.g. apostrophes are dropped, not dashed).`,
      );
    }
    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.Error,
      err instanceof RymOriginBlockError
        ? 'Rate Your Music origin-blocked this page (503). Try again later.'
        : `Rate Your Music request failed: ${errorMessage(err) || 'Unknown error'}`,
    );
  }

  public async albumAsync(ctx: ContextModel, query: string): Promise<ResponseModel> {
    let slug: string;
    if (query) {
      const parsed = parseSlugOrTitle(query);
      if (!parsed.slug) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `Pass \`artist/title\` or \`Artist - Album\` (e.g. \`${ctx.prefix}rma pixies/surfer-rosa\`).`,
        );
      }
      slug = parsed.slug;
    } else {
      const triple = await this.resolveFromLastfm(ctx, 'rma');
      if (triple instanceof ResponseModel) return triple;
      if (!triple.album) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'Your last scrobble has no album name. Pass `Artist - Album` explicitly.',
        );
      }
      slug = releaseSlugFromTriple(triple);
    }
    try {
      const release = await getRelease(this.rymTransport, slug, 'album');
      const coverUrl = release.coverUrl || (await this.artworkService.getAlbumCoverUrl(release.title, release.artist));
      const accentColor = await this.getAccentColor(ctx, coverUrl);
      return RymBuilders.buildReleaseResponse(release, accentColor, coverUrl);
    } catch (err) {
      return this.rymError(err);
    }
  }

  public async trackAsync(ctx: ContextModel, query: string): Promise<ResponseModel> {
    let slug: string;
    if (query) {
      const parsed = parseSlugOrTitle(query);
      if (!parsed.slug) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `Pass \`artist/title\` or \`Artist - Track\` (e.g. \`${ctx.prefix}rmt pixies/bone-machine\`).`,
        );
      }
      slug = parsed.slug;
    } else {
      const triple = await this.resolveFromLastfm(ctx, 'rmt');
      if (triple instanceof ResponseModel) return triple;
      if (!triple.track) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'Your last scrobble has no track name. Pass `Artist - Track` explicitly.',
        );
      }
      slug = `${slugify(triple.artist)}/${slugify(triple.track)}`;
    }
    try {
      const song = await getSong(this.rymTransport, slug);
      const coverUrl = await this.artworkService.getTrackCoverUrl(song.title, song.artist);
      const accentColor = await this.getAccentColor(ctx, coverUrl);
      return RymBuilders.buildSongResponse(song, accentColor, coverUrl);
    } catch (err) {
      return this.rymError(err);
    }
  }

  public async artistAsync(ctx: ContextModel, query: string): Promise<ResponseModel> {    let slug: string;
    if (query) {
      slug = slugify(query);
      if (query.includes('/artist/')) {
        slug = query.split('/artist/')[1]?.split('/')[0] ?? slug;
      }
    } else {
      const triple = await this.resolveFromLastfm(ctx, 'rm');
      if (triple instanceof ResponseModel) return triple;
      if (!triple.artist) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'Your last scrobble has no artist. Pass an artist name.',
        );
      }
      slug = slugify(triple.artist);
    }
    try {
      const artist = await getArtist(this.rymTransport, slug);
      const coverUrl = await this.artworkService.getArtistImageUrl(artist.name);
      const accentColor = await this.getAccentColor(ctx, coverUrl);
      return RymBuilders.buildArtistResponse(artist, accentColor, coverUrl);
    } catch (err) {
      return this.rymError(err);
    }
  }

  public async chartAsync(ctx: ContextModel, query: string): Promise<ResponseModel> {
    const period = query.length > 0 ? query : 'all-time';
    try {
      const stubs = await getChart(this.rymTransport, `/charts/top/album/${period}/`);
      const accentColor = await this.getAccentColor(ctx);
      return RymBuilders.buildChartResponse(period, stubs, accentColor);
    } catch (err) {
      return this.rymError(err);
    }
  }
}
