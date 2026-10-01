/**
 * `buildFooterText` — the `.fm` footer, assembled from a user-selected bitmask.
 *
 * This is the cleanest honesty test in the repo, because the two states are
 * adjacent in one ternary on almost every line:
 *
 *   opts.artistPlays !== undefined   -> render it
 *   otherwise                        -> render nothing
 *
 * The gap between those is "we do not know the artist playcount" and the trap is
 * defaulting it to 0, which is a measurement claim about somebody's listening
 * that no read ever made. So the tests below are mostly about which flags render
 * NOTHING, plus the two fallbacks that can smuggle a value in: the total-scrobble
 * fallback and the `-# ` small-text prefix.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { buildFooterText } from '@bot/builders/footerBuilder';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import type { RecentTrack } from '@domain/models/recentTrack';

const track: RecentTrack = {
  name: 'Karma Police',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: false,
  loved: false,
};

const all = (...flags: FmFooterOption[]) => flags.reduce((mask, f) => mask | BigInt(f), 0n);

const text = (opts: Parameters<typeof buildFooterText>[0]) => buildFooterText(opts);

describe('buildFooterText: a selected option with no value is omitted, not zeroed', () => {
  it('renders nothing at all when the only selected option has no value', () => {
    const out = text({ footerOptions: all(FmFooterOption.ArtistPlays), track });
    expect(out).toBe('');
    expect(out).not.toContain('0');
  });

  it('omits each numeric option independently when its value is missing', () => {
    const mask = all(
      FmFooterOption.ArtistPlays,
      FmFooterOption.AlbumPlays,
      FmFooterOption.TrackPlays,
      FmFooterOption.ArtistPlaysThisWeek,
      FmFooterOption.TotalScrobbles,
      FmFooterOption.ServerArtistListeners,
      FmFooterOption.ServerAlbumListeners,
      FmFooterOption.ServerTrackListeners,
    );
    expect(text({ footerOptions: mask, track })).toBe('');
  });

  it('omits the crown for a null, undefined or empty holder', () => {
    const mask = all(FmFooterOption.CrownHolder);
    expect(text({ footerOptions: mask, track, crownHolder: null })).toBe('');
    expect(text({ footerOptions: mask, track })).toBe('');
    expect(text({ footerOptions: mask, track, crownHolder: '' })).toBe('');
  });

  it('renders a genuine zero, because a zero that was actually read is a real answer', () => {
    // The direction that must NOT be "fixed": 0 artist plays for a user who has
    // never played the artist is true, and hiding it would be the lie.
    const out = text({ footerOptions: all(FmFooterOption.ArtistPlays), track, artistPlays: 0 });
    expect(out).toBe('0 artist plays');
  });
});

describe('buildFooterText: the option bitmask gates what may be rendered', () => {
  it('renders nothing for a value the user never selected', () => {
    const out = text({
      footerOptions: all(FmFooterOption.TotalScrobbles),
      track,
      artistPlays: 500,
      albumPlays: 40,
      trackPlays: 3,
      totalScrobbles: 9,
    });
    expect(out).toBe('9 total scrobbles');
  });

  it('renders every selected value, in the declared order, joined by a middle dot', () => {
    const out = text({
      footerOptions: all(FmFooterOption.ArtistPlays, FmFooterOption.AlbumPlays, FmFooterOption.TrackPlays),
      track,
      artistPlays: 263,
      albumPlays: 12,
      trackPlays: 3,
    });
    expect(out).toBe('263 artist plays · 12 album plays · 3 track plays');
  });

  it('singularises one play, one listener and one scrobble', () => {
    expect(text({ footerOptions: all(FmFooterOption.AlbumPlays), track, albumPlays: 1 })).toBe('1 album play');
    expect(
      text({ footerOptions: all(FmFooterOption.ServerArtistListeners), track, serverArtistListeners: 1 }),
    ).toBe('1 server listener');
    expect(text({ footerOptions: all(FmFooterOption.TotalScrobbles), track, totalScrobbles: 1 })).toBe(
      '1 total scrobbles',
    );
  });

  it('groups the server listener counts by what they are listeners of', () => {
    const out = text({
      footerOptions: all(
        FmFooterOption.ServerArtistListeners,
        FmFooterOption.ServerAlbumListeners,
        FmFooterOption.ServerTrackListeners,
      ),
      track,
      serverArtistListeners: 2,
      serverAlbumListeners: 1,
      serverTrackListeners: 5,
    });
    expect(out).toBe('2 server listeners · 1 server album listener · 5 server track listeners');
  });

  it('renders the crown holder after the play counts, in the declared option order', () => {
    // The order is the one the parts are pushed in, not the order the options
    // were selected: CrownHolder is declared after the three playcounts, so it
    // lands at the end of the line.
    const out = text({
      footerOptions: all(FmFooterOption.CrownHolder, FmFooterOption.TrackPlays),
      track,
      crownHolder: 'someone',
      trackPlays: 2,
    });
    expect(out).toBe('2 track plays · 👑 someone');
  });

  it('labels the weekly artist playcount as a week, not as an all-time count', () => {
    const out = text({
      footerOptions: all(FmFooterOption.ArtistPlays, FmFooterOption.ArtistPlaysThisWeek),
      track,
      artistPlays: 263,
      artistPlaysThisWeek: 7,
    });
    expect(out).toBe('263 artist plays · 7 this week');
  });
});

describe('buildFooterText: the loved flag needs a love', () => {
  it('renders nothing when the flag is set but the track is not loved', () => {
    const out = text({ footerOptions: all(FmFooterOption.Loved), track, isLoved: false });
    expect(out).toBe('');
  });

  it('renders when the call says the track is loved', () => {
    expect(text({ footerOptions: all(FmFooterOption.Loved), track, isLoved: true })).toBe('❤️ Loved');
  });

  it('renders when the track itself carries the love and the caller says nothing', () => {
    expect(text({ footerOptions: all(FmFooterOption.Loved), track: { ...track, loved: true } })).toBe('❤️ Loved');
  });

  it('renders nothing when the flag is NOT set even though the track is loved', () => {
    // The user asked for a footer without the love; showing it anyway would be
    // the builder overriding a user setting.
    expect(text({ footerOptions: 0n, track: { ...track, loved: true }, isLoved: true })).toBe('');
  });
});

describe('buildFooterText: the total-scrobble fallback', () => {
  it('falls back to the scrobble total when nothing else was renderable', () => {
    // Deliberate and useful: the user selected nothing, and a scrobble total is
    // never wrong, so it is a better answer than an empty line.
    expect(text({ footerOptions: 0n, track, totalScrobbles: 188_022 })).toBe('188,022 total scrobbles');
  });

  it('stays empty when there is no scrobble total to fall back to', () => {
    expect(text({ footerOptions: 0n, track })).toBe('');
  });

  it('does not duplicate the total when it was already rendered by its own flag', () => {
    const out = text({ footerOptions: all(FmFooterOption.TotalScrobbles), track, totalScrobbles: 5 });
    expect(out).toBe('5 total scrobbles');
    expect(out.match(/total scrobbles/g)).toHaveLength(1);
  });
});

describe('buildFooterText: small text', () => {
  it('prefixes the whole footer once, not each part', () => {
    const out = text({
      footerOptions: all(FmFooterOption.ArtistPlays, FmFooterOption.TrackPlays),
      track,
      artistPlays: 2,
      trackPlays: 1,
      useSmallText: true,
    });
    expect(out).toBe('-# 2 artist plays · 1 track play');
    expect(out.match(/-#/g)).toHaveLength(1);
  });

  it('formats large counts with thousands separators', () => {
    expect(text({ footerOptions: all(FmFooterOption.ArtistPlays), track, artistPlays: 1_234_567 })).toBe(
      '1,234,567 artist plays',
    );
  });

  /**
   * Small text is a formatting decision about real text, so with no text there is
   * no prefix either. The two branches of the same ternary have to agree: the
   * small-text one used to return the literal "-# ", which renders as an
   * empty-looking footer row — a card element carrying nothing, and a hint that
   * there was something to say.
   */
  it('renders nothing at all when small text was requested and there was nothing to say', () => {
    expect(text({ footerOptions: 0n, track, useSmallText: true })).toBe('');
  });

  it('agrees with the non-small-text branch in every empty case', () => {
    const mask = all(FmFooterOption.Loved, FmFooterOption.ArtistPlays, FmFooterOption.CrownHolder);
    expect(text({ footerOptions: mask, track, useSmallText: true })).toBe(
      text({ footerOptions: mask, track }),
    );
    expect(text({ footerOptions: 0n, track, useSmallText: true })).toBe('');
  });

  it('still prefixes a real fallback total, because that is text worth marking small', () => {
    expect(text({ footerOptions: 0n, track, totalScrobbles: 188_022, useSmallText: true })).toBe(
      '-# 188,022 total scrobbles',
    );
  });
});
