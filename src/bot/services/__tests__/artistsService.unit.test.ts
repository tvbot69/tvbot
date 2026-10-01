import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArtistsService } from '../artistsService';
import type { TopArtist } from '@domain/models/topLists';

/**
 * artistsService was 16% with 350 uncovered lines - the second largest service
 * gap. These cover the four methods that decide what a user actually sees:
 * the cache key, the URL resolver, and the image backfill.
 *
 * The image backfill is the one worth pinning. It has a documented rule -
 * the Last.fm placeholder grey box must never survive as a cover - and that
 * rule appears on BOTH sides of the function: a placeholder coming IN is
 * treated as missing, and a placeholder coming OUT from the artwork service is
 * discarded. An implementation that only checked the input would render the
 * grey box, which is exactly the bug AGENTS.md 3.2 exists to prevent.
 */

const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';
const placeholderUrl = (size = 'large') =>
  `https://lastfm-img.freetls.fastly.net/i/u/${size}/${PLACEHOLDER}.png`;

type Over = Record<string, unknown>;

const build = (over: Over = {}) => {
  const lastfmRepository = {
    getArtistInfo: vi.fn(async () => ({ name: 'Mond', listeners: 1, playCount: 2 })),
    searchArtists: vi.fn(async () => []),
    getTopArtists: vi.fn(async () => []),
    ...(over.lastfmRepository as object),
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined), ...(over.cache as object) };
  const artworkService = { getArtistImageUrl: vi.fn(async () => undefined), ...(over.artworkService as object) };
  const prisma = {
    artist: { findMany: vi.fn(async () => []) },
    ...(over.prisma as object),
  };
  const service = new ArtistsService(
    lastfmRepository as never,
    cache as never,
    over.noArtwork ? undefined : (artworkService as never),
    undefined,
    prisma as never,
  );
  return { service, lastfmRepository, cache, artworkService, prisma };
};

const artist = (name: string, imageUrl?: string): TopArtist => ({ name, playcount: 1, imageUrl });

describe('ArtistsService.getArtistInfo caching', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caches under a key that distinguishes a user view from the global one', async () => {
    // The username is part of the key because Last.fm returns a DIFFERENT
    // playcount for "my plays" than for the global one. Sharing the key would
    // show one user another user's numbers.
    const { service, cache } = build();
    await service.getArtistInfo('Mond', 'DreadRock');
    expect(cache.set).toHaveBeenCalledWith('artist-info:mond:dreadrock', expect.anything(), 3600);
  });

  it('uses a global key when no username is given', async () => {
    const { service, cache } = build();
    await service.getArtistInfo('Mond');
    expect(cache.set).toHaveBeenCalledWith('artist-info:mond:global', expect.anything(), 3600);
  });

  it('lowercases the key so casing cannot split the entry', async () => {
    const { service, cache } = build();
    await service.getArtistInfo('MoNd', 'DReAdRoCk');
    expect(cache.set).toHaveBeenCalledWith('artist-info:mond:dreadrock', expect.anything(), 3600);
  });

  it('serves a cached value without calling Last.fm', async () => {
    const { service, cache, lastfmRepository } = build();
    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'Cached' });
    const info = await service.getArtistInfo('Mond');
    expect(info?.name).toBe('Cached');
    expect(lastfmRepository.getArtistInfo).not.toHaveBeenCalled();
  });

  it('does not cache a null result', async () => {
    const { service, cache, lastfmRepository } = build();
    (lastfmRepository.getArtistInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await service.getArtistInfo('Nobody');
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('ArtistsService.resolveArtistFromLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts the artist from a Last.fm music URL', async () => {
    const { service } = build();
    await expect(service.resolveArtistFromLink('https://www.last.fm/music/Radiohead')).resolves.toBe('Radiohead');
  });

  it('decodes a percent-encoded Last.fm name', async () => {
    const { service } = build();
    await expect(service.resolveArtistFromLink('https://www.last.fm/music/Bj%C3%B6rk')).resolves.toBe('Björk');
  });

  it('turns a plus into a space, because Last.fm uses plus for spaces', async () => {
    const { service } = build();
    await expect(service.resolveArtistFromLink('https://www.last.fm/music/Arcade+Fire')).resolves.toBe('Arcade Fire');
  });

  it('stops at the query string so /music/Radiohead/+albums is not swallowed', async () => {
    const { service } = build();
    await expect(service.resolveArtistFromLink('https://www.last.fm/music/Radiohead/+albums')).resolves.toBe('Radiohead');
  });

  it('extracts the artist from an Apple Music URL and turns hyphens into spaces', async () => {
    const { service } = build();
    await expect(
      service.resolveArtistFromLink('https://music.apple.com/us/artist/tycho/657515'),
    ).resolves.toBe('tycho');
  });

  it('returns null for input that is not a URL', async () => {
    const { service } = build();
    await expect(service.resolveArtistFromLink('Radiohead')).resolves.toBeNull();
    await expect(service.resolveArtistFromLink('')).resolves.toBeNull();
  });

  it('returns null for a URL it does not recognise', async () => {
    const { service } = build();
    await expect(service.resolveArtistFromLink('https://example.com/artist/123')).resolves.toBeNull();
  });
});

describe('ArtistsService.fillArtistImages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns immediately when every artist already has a real image', async () => {
    const { service, artworkService } = build();
    const list = [artist('A', 'https://img/a.png')];
    await expect(service.fillArtistImages(list)).resolves.toEqual(list);
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('does NOT treat the Last.fm placeholder as an image, and looks one up', async () => {
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://img/real.png');

    const [filled] = await service.fillArtistImages([artist('Mond', placeholderUrl())]);

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Mond');
    expect(filled?.imageUrl).toBe('https://img/real.png');
  });

  it('discards a placeholder that the artwork service returns', async () => {
    // The output side of the same rule. An implementation that only filtered
    // the input would write the grey box straight onto the artist.
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockResolvedValue(placeholderUrl('extralarge'));

    const [filled] = await service.fillArtistImages([artist('Mond')]);

    expect(filled?.imageUrl ?? '').not.toContain(PLACEHOLDER);
  });

  it('leaves imageUrl undefined when the lookup finds nothing', async () => {
    const { service } = build();
    const [filled] = await service.fillArtistImages([artist('Unknown')]);
    expect(filled?.imageUrl).toBeUndefined();
  });

  it('survives the artwork service throwing, keeping the original list', async () => {
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const result = await service.fillArtistImages([artist('Mond')]);

    expect(result).toHaveLength(1);
  });

  it('falls back to the database when there is no artwork service', async () => {
    const { service, prisma } = build({ noArtwork: true });
    (prisma.artist.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Mond', imageUrl: 'https://db/mond.png', spotifyImageUrl: 'https://spotify/mond.png', deezerImageUrl: null },
    ]);

    const [filled] = await service.fillArtistImages([artist('mond')]);

    // Spotify beats Deezer beats the plain Last.fm image, and the match is
    // case-insensitive because the typed name and the stored one differ.
    expect(filled?.imageUrl).toBe('https://spotify/mond.png');
  });

  it('never stores a placeholder read out of the database', async () => {
    const { service, prisma } = build({ noArtwork: true });
    (prisma.artist.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Mond', imageUrl: placeholderUrl(), spotifyImageUrl: null, deezerImageUrl: null },
    ]);

    const [filled] = await service.fillArtistImages([artist('Mond')]);

    expect(filled?.imageUrl ?? '').not.toContain(PLACEHOLDER);
  });
});
