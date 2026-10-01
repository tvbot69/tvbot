/**
 * `AlbumBuilders` — the album cover / info / tracks cards.
 *
 * Three things are worth pinning here, and none of them is "did it call the
 * builder": a card is a claim about a measurement, and the interesting failures
 * are all claims that are wrong rather than claims that are missing.
 *
 *  1. A value the service could not supply is OMITTED. `serverPlaycount`,
 *     `userTimeListenedSeconds`, `userPlaycount` — on the tracks footer and on
 *     the info card — and a track's own `playcount` are all guarded by a real
 *     presence test, so an unread number produces a missing clause rather than a
 *     fabricated "0 plays". A SUPPLIED zero still renders, because a zero that
 *     was measured is a real answer; both directions are asserted.
 *  2. Genuinely empty data still produces a valid container: an album with zero
 *     tracks, no cover, no release date and no label must not throw, and must
 *     not render an empty-looking row.
 *  3. `buildAlbumTracksResponse` is the paginator that clamps, and the clamp is
 *     what keeps the footer honest: a page index past the end renders the last
 *     page with the real track count, never "Page 99/2". Its `page` argument is
 *     ONE-based — unlike the raw zero-based index the artist paginators take — so
 *     page 1 is the first page and a page of 0 clamps onto it.
 *
 * Every assertion in this file reads the SERIALISED container, because a card
 * that cannot be serialised cannot be sent: discord.js validates a Section's
 * accessory through a required union, so a section built without one throws at
 * `toJSON()`. The info card therefore hangs the cover on a section when it has
 * one and falls back to a plain text block when it does not, and both shapes
 * serialise.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { AlbumBuilders } from '../albumBuilders';
import type { AlbumSearchResult } from '@bot/services/albumService';
import type { User } from '@domain/interfaces/iuserRepository';
import { UserType, DataSource } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  items?: Array<{ media?: { url?: string }; description?: string }>;
  accessory?: { media?: { url?: string } };
  emoji?: string | { id?: string; name?: string };
  custom_id?: string;
  label?: string;
  url?: string;
  disabled?: boolean;
}

/** The whole container, validated the way the dispatcher validates it before sending. */
const json = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[]; accent_color?: number };

/**
 * Every leaf component, serialised, in render order.
 *
 * Reading the SERIALISED tree rather than the builder objects is deliberate: a
 * card that throws in `toJSON()` cannot be sent, so every content assertion here
 * is also a serialisation assertion. A Section or an ActionRow nests; a Text
 * Display, Button or Media Gallery is a leaf.
 */
const leaves = (response: ResponseModel): Cv2Component[] => {
  const walk = (nodes: Cv2Component[]): Cv2Component[] =>
    nodes.flatMap(node => (node.components ? walk(node.components) : [node]));
  return walk(json(response).components);
};

/** Every rendered text block, in order. */
const texts = (response: ResponseModel): string[] =>
  leaves(response).filter(c => c.type === ComponentType.TextDisplay).map(c => c.content ?? '');

/** Every rendered button, flattened out of the action rows, in render order. */
const buttons = (response: ResponseModel): Cv2Component[] =>
  leaves(response).filter(c => c.type === ComponentType.Button);

const galleryItems = (response: ResponseModel): Array<{ media?: { url?: string }; description?: string }> =>
  leaves(response).flatMap(c => c.items ?? []);

const body = (response: ResponseModel): string => texts(response).join('\n');

/** The serialised Section components of a card. There are none when nothing can hang on one. */
const sections = (response: ResponseModel): Cv2Component[] =>
  json(response).components.filter(c => c.type === ComponentType.Section);

/**
 * The nav row is Album, Cover, then (only when there is more than one page) ◀️
 * and ▶️. Splitting on the emoji rather than on position keeps the assertions
 * readable and survives a reordering of the first two buttons. A serialised
 * button emoji is `{ name }`, never the bare string.
 */
const emojiName = (button: Cv2Component): string | undefined =>
  typeof button.emoji === 'string' ? button.emoji : button.emoji?.name;

const nav = (response: ResponseModel) => {
  const all = buttons(response);
  return {
    all,
    prev: all.find(b => emojiName(b) === '◀️'),
    next: all.find(b => emojiName(b) === '▶️'),
  };
};

const targetUser: User = {
  userId: 7,
  userNameLastFm: 'listener',
  discordUserId: 'discord-1',
  registeredOn: new Date('2024-01-01T00:00:00Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
};

const makeAlbum = (over: Partial<AlbumSearchResult> = {}): AlbumSearchResult => ({
  albumName: 'Selected Ambient Works',
  artistName: 'Aphex Twin',
  albumId: 42,
  tracks: [{ name: 'Xtal', playcount: 7, durationSeconds: 293 }],
  ...over,
});

const tracks = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `Track ${i + 1}`, playcount: i + 1, durationSeconds: 200 }));

describe('AlbumBuilders.buildAlbumTracksResponse', () => {
  it('claims one page of one for an album with no tracks, and says so in words', () => {
    // The empty direction. `totalPages` is floored at 1, so the footer reads
    // "Page 1/1 - 0 total tracks" rather than "Page 1/0", and the body says
    // there are no tracks instead of rendering an empty text block.
    const text = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: [] }), targetUser, 'req'));
    expect(text).toContain('Page 1/1 — 0 total tracks');
    expect(text).toContain('*No tracks found for this album.*');
  });

  it('produces a valid container for an album with no tracks', () => {
    const response = AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: [] }), targetUser, 'req');
    expect(response.isComponentsV2).toBe(true);
    expect(json(response).components.length).toBeGreaterThan(0);
    expect(nav(response).all.map(b => b.label)).toEqual(['Album', 'Cover']);
  });

  it('offers no pagination arrows at all when there is only one page', () => {
    // Not "one disabled pair": no ◀️/▶️ at all, so the card cannot imply there is
    // somewhere else to go.
    const { prev, next } = nav(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(5) }), targetUser, 'req'));
    expect(prev).toBeUndefined();
    expect(next).toBeUndefined();
  });

  it('clamps a page index past the end onto the last real page', () => {
    // The page-count claim is the load-bearing part: a stale button must not
    // produce "Page 99/2", and it must not silently render an empty list as if
    // the album had no more tracks.
    const text = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(13) }), targetUser, 'req', 99));
    expect(text).toContain('Page 2/2 — 13 total tracks');
    expect(text).toContain('13. **Track 13**');
  });

  it('clamps a page before the first one back onto page 1', () => {
    for (const page of [0, -5]) {
      const text = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(13) }), targetUser, 'req', page));
      expect(text).toContain('Page 1/2 — 13 total tracks');
      expect(text).toContain('1. **Track 1**');
      // No line STARTS at zero. A plain `not.toContain('0. **')` would trip over
      // "10. **Track 10**", which is on this very page.
      expect(text).not.toMatch(/^0\. \*\*/m);
    }
  });

  it('numbers tracks continuously across pages rather than restarting at 1', () => {
    // `page` is one-based here, so page 2 of 3 is the middle page: tracks 13-24,
    // not a fresh 1-12.
    const text = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(25) }), targetUser, 'req', 2));
    expect(text).toContain('Page 2/3 — 25 total tracks');
    expect(text).toContain('13. **Track 13**');
    expect(text).toContain('24. **Track 24**');
    expect(text).not.toContain('1. **Track 1**');
  });

  it('encodes the current and adjacent pages in the arrow custom ids', () => {
    const { prev, next } = nav(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(25) }), targetUser, 'req', 2));
    expect(prev?.custom_id).toBe('album-tracks:42:discord-1:discord-1:1');
    expect(next?.custom_id).toBe('album-tracks:42:discord-1:discord-1:3');
  });

  it('leaves both arrows live in the middle of the album', () => {
    const { prev, next } = nav(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(25) }), targetUser, 'req', 2));
    expect(prev?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);
  });

  it('disables ▶️ on the final page', () => {
    const { prev, next } = nav(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(25) }), targetUser, 'req', 3));
    expect(prev?.disabled).toBe(false);
    expect(next?.disabled).toBe(true);
  });

  it('disables ◀️ on the first page', () => {
    const { prev, next } = nav(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ tracks: tracks(25) }), targetUser, 'req', 1));
    expect(prev?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);
  });

  it('omits the play clause for a track with no counted plays, instead of printing 0 plays', () => {
    // A track the user has never played renders as a bare line. Printing
    // "0 plays" here would be a claim about a measurement, and the measurement
    // was never taken.
    const text = body(
      AlbumBuilders.buildAlbumTracksResponse(
        makeAlbum({
          tracks: [
            { name: 'Never Played', playcount: 0, durationSeconds: 180 },
            { name: 'Unknown Count', durationSeconds: 181 },
          ],
        }),
        targetUser,
        'req',
      ),
    );
    expect(text).toContain('1. **Never Played** — `3:00`');
    expect(text).not.toContain('0 plays');
    expect(text).toContain('2. **Unknown Count** — `3:01`');
  });

  it('omits a zero duration rather than rendering a 0:00 clock', () => {
    const text = body(
      AlbumBuilders.buildAlbumTracksResponse(
        makeAlbum({ tracks: [{ name: 'No Length', playcount: 3, durationSeconds: 0 }] }),
        targetUser,
        'req',
      ),
    );
    expect(text).toContain('1. **No Length** - *3 plays*');
    expect(text).not.toContain('0:00');
  });

  it('formats a long track as h:mm:ss and a short one as m:ss, and singularises one play', () => {
    const text = body(
      AlbumBuilders.buildAlbumTracksResponse(
        makeAlbum({
          tracks: [
            { name: 'Short', playcount: 1, durationSeconds: 65 },
            { name: 'Long', playcount: 2, durationSeconds: 3725 },
          ],
        }),
        targetUser,
        'req',
      ),
    );
    expect(text).toContain('*1 play*');
    expect(text).toContain('*2 plays*');
    expect(text).toContain('`1:05`');
    expect(text).toContain('`1:02:05`');
  });

  it('hangs the album duration off the track count only when there is one', () => {
    const withoutDuration = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum(), targetUser, 'req'));
    const withDuration = body(
      AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ totalDurationSeconds: 3725 }), targetUser, 'req'),
    );
    // The em dash lives inside the duration string, so a missing length must not
    // leave "total track —" dangling at the end of the line. The noun agrees with
    // the count: one track is "1 total track", not "1 total tracks".
    expect(withoutDuration).toContain('1 total track\n');
    expect(withoutDuration).not.toContain('total track —\n');
    expect(withDuration).toContain('1 total track — 1:02:05');
  });
});

describe('AlbumBuilders.buildAlbumInfoResponse', () => {
  it('omits the release and label lines entirely when neither is known', () => {
    const text = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req'));
    expect(text).toContain('Album by **Aphex Twin**');
    expect(text).not.toContain('Released on');
    expect(text).not.toContain('Label:');
  });

  it('renders the release as a Discord timestamp when a date is known', () => {
    const text = body(
      AlbumBuilders.buildAlbumInfoResponse(
        makeAlbum({ releaseDate: new Date('1992-04-09T00:00:00Z'), label: 'Warp' }),
        targetUser,
        'req',
      ),
    );
    // 1992-04-09T00:00:00Z is unix 702777600.
    expect(text).toContain('Released on **<t:702777600:D>**');
    expect(text).toContain('-# Label: Warp');
  });

  it('links the artist and album when Last.fm gave us urls, and prints bare names when it did not', () => {
    const linked = body(
      AlbumBuilders.buildAlbumInfoResponse(
        makeAlbum({ albumUrl: 'https://last.fm/album/1', artistUrl: 'https://last.fm/artist/2' }),
        targetUser,
        'req',
      ),
    );
    const bare = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req'));
    expect(linked).toContain('## [Selected Ambient Works](https://last.fm/album/1)');
    expect(linked).toContain('Album by **[Aphex Twin](https://last.fm/artist/2)**');
    expect(bare).toContain('## Selected Ambient Works');
    expect(bare).toContain('Album by **Aphex Twin**');
  });

  it('truncates a long summary to 300 characters and leaves a 300-character one alone', () => {
    const truncated = body(
      AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ summary: 'x'.repeat(400) }), targetUser, 'req'),
    );
    const untouched = body(
      AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ summary: 'y'.repeat(300) }), targetUser, 'req'),
    );
    expect(truncated).toContain('x'.repeat(297) + '...');
    expect(truncated).not.toContain('x'.repeat(298));
    expect(untouched).toContain('y'.repeat(300));
    expect(untouched).not.toContain('y'.repeat(301));
  });

  it('renders server and global lines only when BOTH halves of each pair are known', () => {
    // A playcount with no listener count is a half-answer. Rendering it would
    // print either a made-up listener count or a bare number with no unit.
    const halfServer = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ serverPlaycount: 12 }), targetUser, 'req'));
    const halfGlobal = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ globalListeners: 900 }), targetUser, 'req'));
    const both = body(
      AlbumBuilders.buildAlbumInfoResponse(
        makeAlbum({ serverPlaycount: 12, serverListeners: 1, globalPlaycount: 5000, globalListeners: 900 }),
        targetUser,
        'req',
      ),
    );
    expect(halfServer).not.toContain('plays in this server');
    expect(halfGlobal).not.toContain('Last.fm plays by');
    expect(both).toContain('**12** plays in this server by **1** listener');
    expect(both).toContain('**5000** Last.fm plays by **900** listeners');
  });

  it('singularises a single server listener', () => {
    const text = body(
      AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ serverPlaycount: 1, serverListeners: 1 }), targetUser, 'req'),
    );
    expect(text).toContain('**1** plays in this server by **1** listener');
  });

  it('omits the listened line when no listening time is known', () => {
    const text = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userPlaycount: 4 }), targetUser, 'req'));
    expect(text).not.toContain('listened');
  });

  it('renders the percentage whenever the service supplied one, including a measured zero', () => {
    // The guard here is presence, not magnitude: the value only reaches the card
    // at all if the service read it, so a supplied 0% is a real answer. (The
    // artist card guards with `> 0` instead — a difference worth knowing about,
    // but neither of the two is printing a number nobody measured.)
    const withPct = body(
      AlbumBuilders.buildAlbumInfoResponse(
        makeAlbum({ userTimeListenedSeconds: 5400, userPercentageOfAllPlays: 12.5 }),
        targetUser,
        'req',
      ),
    );
    const zeroPct = body(
      AlbumBuilders.buildAlbumInfoResponse(
        makeAlbum({ userTimeListenedSeconds: 5400, userPercentageOfAllPlays: 0 }),
        targetUser,
        'req',
      ),
    );
    const noPct = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userTimeListenedSeconds: 5400 }), targetUser, 'req'));
    const exactHour = body(
      AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userTimeListenedSeconds: 3600 }), targetUser, 'req'),
    );

    // 5400s is an hour and a half, and the coarse formatter keeps the minutes
    // whenever the span is under a day.
    expect(withPct).toContain('**1 hour, 30 minutes** listened — **12.5%** of all your plays');
    expect(zeroPct).toContain('**1 hour, 30 minutes** listened — **0%** of all your plays');
    // Absent is the only thing that leaves the clause off.
    expect(noPct).toContain('**1 hour, 30 minutes** listened');
    expect(noPct).not.toContain('of all your plays');
    expect(exactHour).toContain('**1 hour** listened');
  });

  it('renders a multi-day listening time in the coarse unit rather than as hours alone', () => {
    const text = body(
      AlbumBuilders.buildAlbumInfoResponse(
        makeAlbum({ userTimeListenedSeconds: 86400 * 2 + 3600 * 3 + 60 * 20 }),
        targetUser,
        'req',
      ),
    );
    // 2 days, 3 hours, 20 minutes -> days, hours and no minutes (minutes only
    // render when the span is under a day).
    expect(text).toContain('**2 days, 3 hours** listened');
  });

  it('renders a sub-hour listening time in minutes', () => {
    const text = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userTimeListenedSeconds: 600 }), targetUser, 'req'));
    expect(text).toContain('**10 minutes** listened');
  });

  it('does not add a last-month clause for a month with no plays', () => {
    const zero = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userPlaycount: 3 }), targetUser, 'req'));
    const some = body(
      AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userPlaycount: 3, userMonthlyPlaycount: 2 }), targetUser, 'req'),
    );
    expect(zero).not.toContain('last month');
    expect(some).toContain('**2** last month');
  });

  it('adds the streaming link buttons only for the services it actually has a url for', () => {
    const linkButtons = (r: ResponseModel) => buttons(r).filter(b => b.url);
    const none = AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req');
    const lastFmOnly = AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ albumUrl: 'https://last.fm/a' }), targetUser, 'req');
    const both = AlbumBuilders.buildAlbumInfoResponse(
      makeAlbum({ albumUrl: 'https://last.fm/a', spotifyUrl: 'https://open.spotify.com/a' }),
      targetUser,
      'req',
    );
    expect(linkButtons(none)).toEqual([]);
    expect(linkButtons(lastFmOnly).map(b => b.label)).toEqual(['Last.fm']);
    expect(linkButtons(both).map(b => b.label).sort()).toEqual(['Last.fm', 'Spotify']);
  });

  it('always offers Tracks and Cover, even for an album with no tracks at all', () => {
    // The nav row is the escape hatch out of an empty card. Dropping it because
    // the data was empty would strand the user on "No tracks found".
    const labels = buttons(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ tracks: [] }), targetUser, 'req')).map(
      b => b.label,
    );
    expect(labels).toEqual(['Tracks', 'Cover']);
  });

  it('hangs the cover on a section, and falls back to a plain text block when there is none', () => {
    // Both shapes serialise, which is the whole point: discord.js validates a
    // Section's accessory through a required union, so a section with no accessory
    // throws in `toJSON()` and the card can never be sent. With no cover the header
    // is a plain text block, exactly as the artist cards already do it.
    const withCover = AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ albumCoverUrl: 'https://img/cover.jpg' }), targetUser, 'req');
    const without = AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req');
    expect(sections(withCover)).toHaveLength(1);
    expect(sections(withCover)[0]?.accessory?.media?.url).toBe('https://img/cover.jpg');
    expect(sections(without)).toEqual([]);
    expect(json(without).components.some(c => (c.content ?? '').includes('Album by **Aphex Twin**'))).toBe(true);
  });
});

describe('AlbumBuilders.buildCoverResponse', () => {
  it('still builds a card for an album with no cover, no urls and no extras', () => {
    const response = AlbumBuilders.buildCoverResponse(
      makeAlbum({ albumCoverUrl: undefined, albumUrl: undefined, artistUrl: undefined }),
      targetUser,
      'someone',
    );
    expect(galleryItems(response)).toEqual([]);
    expect(body(response)).toContain('**Aphex Twin - Selected Ambient Works**');
    expect(body(response)).toContain('Requested by someone');
  });

  it('describes the gallery item so the image is not an unexplained picture', () => {
    const response = AlbumBuilders.buildCoverResponse(makeAlbum({ albumCoverUrl: 'https://img/c.jpg' }), targetUser, 'req');
    expect(galleryItems(response)).toEqual([
      { media: { url: 'https://img/c.jpg' }, description: 'Album cover for Selected Ambient Works by Aphex Twin' },
    ]);
  });

  it('points both nav buttons back at the same target user', () => {
    const response = AlbumBuilders.buildCoverResponse(makeAlbum(), targetUser, 'req');
    expect(buttons(response).map(b => b.custom_id)).toEqual([
      'album-info:42:discord-1:discord-1',
      'album-tracks:42:discord-1:discord-1:',
    ]);
  });

  it('sets the container accent only when one was supplied', () => {
    expect(json(AlbumBuilders.buildCoverResponse(makeAlbum(), targetUser, 'req', 0x112233)).accent_color).toBe(0x112233);
    expect(json(AlbumBuilders.buildCoverResponse(makeAlbum(), targetUser, 'req')).accent_color).toBeUndefined();
  });
});

/**
 * An unread playcount is omitted, and a supplied zero is still rendered. The two
 * directions are opposites, so both are asserted: the fix is the guard, not the
 * removal of the clause.
 */
describe('AlbumBuilders: an unread playcount is omitted rather than printed as zero', () => {
  it('drops the listener play clause from the tracks footer when userPlaycount was never supplied', () => {
    const text = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum(), targetUser, 'req'));
    // The rest of the footer line still stands, so this is not a bare "no text".
    expect(text).toContain('-# Album source: Last.fm');
    expect(text).not.toContain('total album plays');
    expect(text).not.toMatch(/has \d+ total album plays/);
  });

  it('drops the "plays by" clause from the info card when userPlaycount was never supplied', () => {
    const text = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req'));
    expect(text).not.toMatch(/\*\*\d+\*\* plays by \*\*/);
    expect(text).not.toContain('plays by **listener**');
  });

  it('leaves no empty-looking separator or text block behind when the clause is the only stat', () => {
    // Two separators back to back with nothing between them is exactly the
    // empty-looking row the rest of this file is against.
    const response = AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req');
    const texts = json(response).components.filter(c => c.type === ComponentType.TextDisplay);
    expect(texts.every(c => (c.content ?? '').trim().length > 0)).toBe(true);
  });

  it('still prints the real number when one is supplied, on both cards', () => {
    const info = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userPlaycount: 3 }), targetUser, 'req'));
    const tracks = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ userPlaycount: 3 }), targetUser, 'req'));
    expect(info).toContain('**3** plays by **listener**');
    expect(tracks).toContain('listener has 3 total album plays');
  });

  it('still prints a supplied zero, because a measured zero is a real answer', () => {
    const info = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ userPlaycount: 0 }), targetUser, 'req'));
    const tracks = body(AlbumBuilders.buildAlbumTracksResponse(makeAlbum({ userPlaycount: 0 }), targetUser, 'req'));
    expect(info).toContain('**0** plays by **listener**');
    expect(tracks).toContain('listener has 0 total album plays');
  });
});

/**
 * The info card is SENDABLE whether or not the album has a cover. discord.js does
 * NOT treat a section's accessory as optional — its `toJSON()` runs the accessory
 * through a required union validator — so the old shape (a section built
 * unconditionally, with the accessory set only when a cover existed) threw at the
 * moment the dispatcher handed the card to Discord, and the user got `.album`'s
 * error path instead of a card.
 */
describe('AlbumBuilders: the info card serialises with and without a cover', () => {
  it('serialises an album with no cover instead of throwing', () => {
    const response = AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req');
    expect(() => json(response)).not.toThrow();
    expect(json(response).components.length).toBeGreaterThan(0);
  });

  it('serialises an album with a cover', () => {
    const response = AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ albumCoverUrl: 'https://img/c.jpg' }), targetUser, 'req');
    expect(() => json(response)).not.toThrow();
  });

  it('is the accessory and not a malformed header: the text itself reads fine either way', () => {
    const withCover = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum({ albumCoverUrl: 'https://img/c.jpg' }), targetUser, 'req'));
    const without = body(AlbumBuilders.buildAlbumInfoResponse(makeAlbum(), targetUser, 'req'));
    expect(withCover).toContain('Album by **Aphex Twin**');
    expect(without).toBe(withCover);
  });

  it('sends the same nav buttons whichever shape the header took', () => {
    const labels = (over: Partial<AlbumSearchResult>) =>
      buttons(AlbumBuilders.buildAlbumInfoResponse(makeAlbum(over), targetUser, 'req')).map(b => b.label);
    expect(labels({})).toEqual(labels({ albumCoverUrl: 'https://img/c.jpg' }));
  });
});
