/**
 * `ChartBuilders` — the `.chart` album/artist/track cards and the
 * "not enough images" refusal.
 *
 * A chart card is almost entirely a claim about an IMAGE, and the ways that can
 * go wrong are all here:
 *
 *  1. The scrobble count line. `totalPlayCount` is `number | undefined` on the
 *     user row, so the line is guarded by presence: an unread count is never
 *     rendered as "has 0 scrobbles". A supplied zero still renders.
 *  2. A `ChartResult` with neither `imageUrl` nor `buffer` used to produce a card
 *     with a heading, an Edit button and no chart, and nothing on it saying the
 *     render failed. It now says so.
 *  3. The Edit button. Its custom id embeds the creator's Discord id and
 *     `ChartInteractions.handleEditButton` refuses anyone whose
 *     `interaction.user.id` does not match it, so a card that renders the button
 *     without a real creator id offers a control its own handler will reject. The
 *     button is rendered only when the author object carries a Discord snowflake.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { ChartBuilders } from '../chartBuilders';
import { ChartSettings } from '@bot/models/chartModels';
import { NotEnoughAlbumsError } from '@bot/services/chartService';
import { TimePeriod } from '@domain/enums/timePeriod';
import { TimeSettingsModel } from '@domain/models/timeSettings';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UserType, DataSource } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { ChartResult } from '@bot/services/chartService';
import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  items?: Array<{ media?: { url?: string }; description?: string }>;
  accessory?: { custom_id?: string; label?: string };
  custom_id?: string;
  label?: string;
}

const json = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[]; accent_color?: number };

const texts = (response: ResponseModel): string[] =>
  json(response).components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content ?? '');

/**
 * The scrobble count lives inside a Section (it shares the row with the Edit
 * button), so it is NOT a top-level text block. Reading `texts()` for it would
 * pass for the wrong reason.
 */
const sectionTexts = (response: ResponseModel): string[] =>
  json(response)
    .components.filter(c => c.type === ComponentType.Section)
    .flatMap(c => c.components ?? [])
    .filter(c => c.type === ComponentType.TextDisplay)
    .map(c => c.content ?? '');

const galleryItems = (response: ResponseModel) =>
  json(response).components.filter(c => c.type === ComponentType.MediaGallery).flatMap(c => c.items ?? []);

/** The edit button, which is the section's accessory rather than a top-level row. */
const editButton = (response: ResponseModel) =>
  json(response)
    .components.filter(c => c.type === ComponentType.Section)
    .flatMap(c => (c.accessory ? [c.accessory] : []));

/**
 * The scrobble line rides in a Section when the Edit button is present and is a
 * plain top-level text block when it is not, so an assertion about it has to read
 * both. Reading only the section would pass for the wrong reason.
 */
const scrobbleLine = (response: ResponseModel): string => [...sectionTexts(response), ...texts(response)].join('\n');

const user: User = {
  userId: 3,
  userNameLastFm: 'listener',
  // A real Discord snowflake: the Edit button's custom id embeds it and
  // `ChartInteractions` compares it against `interaction.user.id`.
  discordUserId: '100000000000000001',
  registeredOn: new Date('2024-01-01T00:00:00Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  totalPlayCount: 188_022,
};

/**
 * What `chartSlashCommands` actually passes: an author object carrying only the
 * Last.fm name and the play count. There is no Discord id on it, so no button
 * whose handler could ever accept a press.
 */
const userWithoutCreator: User = {
  userNameLastFm: 'listener',
  totalPlayCount: 188_022,
} as User;

const topAlbum = (name: string, artistName = 'Radiohead', playcount = 10): TopAlbum => ({ name, artistName, playcount });
const topArtist = (name: string, playcount = 10): TopArtist => ({ name, playcount });
const topTrack = (name: string, artistName = 'Radiohead', playcount = 10): TopTrack => ({ name, artistName, playcount });

const settings = (over: Partial<ChartSettings> = {}): ChartSettings => {
  const s = new ChartSettings();
  s.width = 3;
  s.height = 3;
  s.timespanString = 'Weekly';
  const time = new TimeSettingsModel('weekly');
  time.timePeriod = TimePeriod.Weekly;
  time.urlParameter = '7day';
  s.timeSettings = time;
  Object.assign(s, over);
  return s;
};

const result = (over: Partial<ChartResult> = {}): ChartResult => ({
  imageUrl: 'https://img/chart.png',
  albumsUsed: [topAlbum('Kid A'), topAlbum('Amnesiac')],
  ...over,
});

describe('ChartBuilders chart cards', () => {
  it('titles the card with the size, the period and a link to the library it came from', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, 'Tester', result(), settings());
    expect(texts(response)[0]).toBe(
      '**[3x3 weekly chart](https://www.last.fm/user/listener/library/albums?date_preset=7day) for tester**',
    );
  });

  it('lower-cases the Discord display name and falls back to the Last.fm name', () => {
    const withDiscord = ChartBuilders.buildAlbumChartResponse(user, 'MixedCase', result(), settings());
    const withoutDiscord = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(texts(withDiscord)[0]).toContain('for mixedcase**');
    expect(texts(withoutDiscord)[0]).toContain('for listener**');
  });

  it('omits the date preset for an all-time chart rather than sending an empty query', () => {
    const allTime = settings({ timespanString: 'Alltime' });
    allTime.timeSettings = new TimeSettingsModel('alltime');
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), allTime);
    expect(texts(response)[0]).toContain('/library/albums)');
    expect(texts(response)[0]).not.toContain('date_preset');
  });

  it('points the library link at tracks or artists when that is what was charted', () => {
    const tracks = settings({ trackChart: true });
    tracks.timeSettings = undefined;
    const artists = settings({ artistChart: true });
    artists.timeSettings = undefined;

    expect(texts(ChartBuilders.buildTrackChartResponse(user, undefined, result(), tracks))[0]).toContain(
      '/library/tracks)',
    );
    expect(texts(ChartBuilders.buildArtistChartResponse(user, undefined, result(), artists))[0]).toContain(
      '/library/music)',
    );
  });

  it('shows the scrobble count that was actually stored on the user row', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(sectionTexts(response)).toContain('-# listener has 188,022 scrobbles');
  });

  it('attaches the rendered chart as a media gallery item', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(galleryItems(response)).toHaveLength(1);
    expect(galleryItems(response)[0]?.media?.url).toBe('https://img/chart.png');
  });

  it('describes the gallery item with the entities that went into the chart', () => {
    const response = ChartBuilders.buildAlbumChartResponse(
      user,
      undefined,
      result({ albumsUsed: [topAlbum('Kid A'), topAlbum('Amnesiac')] }),
      settings(),
    );
    expect(galleryItems(response)[0]?.description).toBe('#1 Kid A by Radiohead, #2 Amnesiac by Radiohead');
  });

  it('uses the bare entity name when the entity has no artist to name', () => {
    const response = ChartBuilders.buildArtistChartResponse(
      user,
      undefined,
      result({ artistsUsed: [topArtist('Radiohead'), topArtist('Boards of Canada')] }),
      settings({ artistChart: true }),
    );
    expect(galleryItems(response)[0]?.description).toBe('#1 Radiohead, #2 Boards of Canada');
  });

  it('names the artist on a track chart, because track names alone are ambiguous', () => {
    const response = ChartBuilders.buildTrackChartResponse(
      user,
      undefined,
      result({ tracksUsed: [topTrack('Creep'), topTrack('Karma Police')] }),
      settings({ trackChart: true }),
    );
    expect(galleryItems(response)[0]?.description).toBe('#1 Creep by Radiohead, #2 Karma Police by Radiohead');
  });

  it('leaves the gallery item undescribed when the chart used nothing it could name', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result({ albumsUsed: [] }), settings());
    expect(galleryItems(response)).toHaveLength(1);
    expect(galleryItems(response)[0]?.description).toBeUndefined();
  });

  it('renders the upload buffer as an attachment rather than as a dead image url', () => {
    const buffer = Buffer.from('not-really-a-png');
    const response = ChartBuilders.buildAlbumChartResponse(
      user,
      undefined,
      result({ imageUrl: undefined, buffer }),
      settings(),
    );
    expect(galleryItems(response)[0]?.media?.url).toBe('attachment://chart.png');
    expect(response.hasFile()).toBe(true);
    expect(response.getFiles()[0]?.name).toBe('chart.png');
    expect(response.getFiles()[0]?.attachment).toBe(buffer);
  });

  it('prefers the uploaded url over the buffer when both are present', () => {
    const response = ChartBuilders.buildAlbumChartResponse(
      user,
      undefined,
      result({ imageUrl: 'https://img/chart.png', buffer: Buffer.from('x') }),
      settings(),
    );
    expect(galleryItems(response)[0]?.media?.url).toBe('https://img/chart.png');
    expect(response.hasFile()).toBe(false);
  });

  it('encodes the chart type in the edit button so the editor knows what it is editing', () => {
    const album = editButton(ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings()));
    const artist = editButton(
      ChartBuilders.buildArtistChartResponse(user, undefined, result(), settings({ artistChart: true })),
    );
    const track = editButton(
      ChartBuilders.buildTrackChartResponse(user, undefined, result(), settings({ trackChart: true })),
    );
    expect(album[0]?.custom_id).toContain('chart-edit:100000000000000001:a:3x3:weekly:');
    expect(artist[0]?.custom_id).toContain('chart-edit:100000000000000001:r:3x3:weekly:');
    expect(track[0]?.custom_id).toContain('chart-edit:100000000000000001:t:3x3:weekly:');
  });

  it('falls back to an "overall" period token when the time settings are missing', () => {
    const noTime = settings();
    noTime.timeSettings = undefined;
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), noTime);
    expect(editButton(response)[0]?.custom_id).toContain(':overall:');
    expect(texts(response)[0]).toContain('/library/albums)');
  });

  it('stops listing entities rather than overflowing the gallery alt text', () => {
    // Discord caps a media gallery description; the builder stops adding lines
    // rather than emitting something the API will reject.
    const many = Array.from({ length: 80 }, (_, i) => topAlbum(`Album number ${i} with a long name`));
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result({ albumsUsed: many }), settings());
    const description = galleryItems(response)[0]?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(340);
    expect(description).toContain('#1 Album number 0 with a long name by Radiohead');
  });

  it('produces a valid container when nothing was rendered and nothing was uploaded', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result({ imageUrl: undefined }), settings());
    expect(response.isComponentsV2).toBe(true);
    expect(json(response).components.length).toBeGreaterThan(0);
    // The failure notice is rendered, so the title is no longer the first block.
    expect(texts(response).some(t => t.includes('[3x3 weekly chart]'))).toBe(true);
  });

  it('sets the container accent only when one was supplied', () => {
    const accented = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings(), 0x2468ac);
    const plain = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(json(accented).accent_color).toBe(0x2468ac);
    expect(json(plain).accent_color).toBeUndefined();
  });
});

/**
 * These assert the STRING, not the flag on the error. A test that asserts
 * `error.afterFilters` was a test that passed on every mislabelling in this
 * file and would have kept passing after the rename; a test that asserts what
 * the user reads dies when the text starts lying, and it dies for the reason
 * that matters.
 */
describe('ChartBuilders.buildNotEnoughAlbumsError says which stage fell short', () => {
  const desc = (error: NotEnoughAlbumsError, chartType?: 'album' | 'artist' | 'track' | boolean) =>
    ChartBuilders.buildNotEnoughAlbumsError(error, chartType).embed.data.description ?? '';

  it('names albums, artists or tracks according to what was being charted', () => {
    const error = new NotEnoughAlbumsError(4, 9);
    expect(desc(error)).toContain(
      'You have listened to **4** albums in this time period, but a chart of **9** images was requested.',
    );
    expect(desc(error, 'artist')).toContain('**4** artists in this time period');
    expect(desc(error, 'track')).toContain('**4** tracks in this time period');
  });

  it('names the item type on the two causes that are not about listening totals', () => {
    // The lead sentence is rebuilt per cause, so a rebuild can quietly lose the
    // plural and the card ends up talking about "4 matched the filters" with no
    // subject at all.
    expect(desc(new NotEnoughAlbumsError(4, 9, 'filters'), 'artist')).toContain('of your artists matched the filters');
    expect(desc(new NotEnoughAlbumsError(4, 9, 'covers'), 'track')).toContain('of the tracks Last.fm returned');
  });

  it('treats the legacy boolean argument as "artists", which is what it always meant', () => {
    expect(desc(new NotEnoughAlbumsError(2, 9), true)).toContain('**2** artists');
  });

  it('blames the cover pass, and only the cover pass, when the covers ran out', () => {
    // Nothing was filtered on this path. The old card said "remained after
    // filters or missing covers", which told a user who never set a filter to go
    // and widen one.
    const covers = desc(new NotEnoughAlbumsError(4, 9, 'covers'));
    expect(covers).toContain('had a usable cover');
    expect(covers).toContain('This is a cover problem, not a filter one.');
    expect(covers).not.toContain('matched the filters');
    expect(covers).not.toContain('widen or clear the artist, release year/decade or singles filter');
  });

  it('blames the filter, and only the filter, when a release filter dropped rows', () => {
    const filtered = desc(new NotEnoughAlbumsError(4, 9, 'filters'));
    expect(filtered).toContain('matched the filters on this chart');
    expect(filtered).toContain('Widen or clear the artist, release year/decade or singles filter');
    expect(filtered).not.toContain('usable cover');
    expect(filtered).not.toContain('This is a cover problem');
  });

  it('blames the cover pass in its advice too, not only in its headline', () => {
    // The headline and the advice are two separate strings, so a fix that only
    // rewrote one of them leaves the user with the other half of the lie.
    const covers = desc(new NotEnoughAlbumsError(4, 9, 'covers'));
    expect(covers).toContain('Turn off `skip`/`ns`');
    expect(covers).not.toContain('Widen or clear the artist');
    expect(covers).not.toContain('your filters removed the rest');
  });

  it('never claims a filter or a cover problem on an upstream shortfall', () => {
    const upstream = desc(new NotEnoughAlbumsError(4, 9, 'upstream'));
    expect(upstream).toContain('Try a smaller chart size, or use a different time period like `weekly`');
    expect(upstream).not.toContain('matched the filters');
    expect(upstream).not.toContain('usable cover');
    expect(upstream).not.toContain('Widen or clear the artist');
    expect(upstream).not.toContain('Your filters removed the rest');
    expect(upstream).not.toContain('This is a cover problem');
  });

  it('does not print a listening total on the two causes where `available` is not one', () => {
    // `available` under `covers` is how many had artwork, and under `filters` how
    // many survived. "You have listened to 4 albums" on either card is a
    // fabricated claim about somebody's listening history, and the numbers are
    // plausible enough to be believed.
    expect(desc(new NotEnoughAlbumsError(4, 9, 'covers'))).not.toContain('You have listened to');
    expect(desc(new NotEnoughAlbumsError(4, 9, 'filters'))).not.toContain('You have listened to');
  });

  it('marks itself as wrong input rather than as a failure, so the caller can re-prompt', () => {
    const response = ChartBuilders.buildNotEnoughAlbumsError(new NotEnoughAlbumsError(1, 9));
    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(response.isComponentsV2).toBe(false);
  });
});

/**
 * `totalPlayCount` is `number | undefined` on the user row, so the line is guarded
 * by presence. The old `?? 0` turned "we do not know" into "0 scrobbles", which
 * is a measurement claim about the listener — and a chart with no image AND a
 * scroble count of zero is two confident wrong claims stacked on one card. A
 * supplied zero is still rendered, because a zero that was measured is an answer.
 */
describe('ChartBuilders: an unread play count is not rendered as a number', () => {
  it('never prints a scrobble count the user row does not have', () => {
    const { totalPlayCount: _ignored, ...withoutCount } = user;
    const response = ChartBuilders.buildAlbumChartResponse(withoutCount as User, undefined, result(), settings());
    expect(scrobbleLine(response)).not.toMatch(/has \d+ scrobbles/);
    expect(scrobbleLine(response)).not.toContain('0 scrobbles');
    expect(scrobbleLine(response)).toContain('Scrobble total unavailable');
  });

  it('still prints the real total when one is stored, so the omission is a guard and not the path', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(scrobbleLine(response)).toContain('-# listener has 188,022 scrobbles');
  });

  it('still prints a supplied zero, because a measured zero is a real answer', () => {
    const response = ChartBuilders.buildAlbumChartResponse(
      { ...user, totalPlayCount: 0 },
      undefined,
      result(),
      settings(),
    );
    expect(scrobbleLine(response)).toContain('-# listener has 0 scrobbles');
  });
});

/**
 * A `ChartResult` with neither `imageUrl` nor `buffer` means the render produced
 * nothing. The card used to be a heading, an Edit button and an empty space, which
 * is a chart-shaped hole: the user cannot tell a failed render from a blank album.
 */
describe('ChartBuilders: a chart that failed to render says so', () => {
  const nothing = { imageUrl: undefined, buffer: undefined } as Partial<ChartResult>;

  it('states the failure in words instead of leaving a chart-shaped hole', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(nothing), settings());
    const notice = texts(response).find(t => t.includes('chart'));
    expect(notice).toBeDefined();
    expect(notice).toContain('The chart image could not be generated');
  });

  it('sends no gallery item and no attachment for a render that produced nothing', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(nothing), settings());
    expect(galleryItems(response)).toEqual([]);
    expect(response.hasFile()).toBe(false);
  });

  it('says nothing of the sort when the chart did render', () => {
    const rendered = texts(ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings()));
    expect(rendered.some(t => t.includes('could not be generated'))).toBe(false);
  });

  it('says the same thing whichever of the three chart types failed', () => {
    const album = ChartBuilders.buildAlbumChartResponse(user, undefined, result(nothing), settings());
    const artist = ChartBuilders.buildArtistChartResponse(
      user,
      undefined,
      result(nothing),
      settings({ artistChart: true }),
    );
    const track = ChartBuilders.buildTrackChartResponse(user, undefined, result(nothing), settings({ trackChart: true }));
    const notice = (r: ResponseModel) => texts(r).find(t => t.includes('could not be generated'));
    // Asserting the notice exists first, or `undefined === undefined` would pass
    // on a card that says nothing at all.
    expect(notice(album)).toBeDefined();
    expect(notice(artist)).toBe(notice(album));
    expect(notice(track)).toBe(notice(album));
  });
});

/**
 * The Edit button is only honest when its own handler can accept it.
 * `ChartInteractions.handleEditButton` compares `interaction.user.id` against the
 * id embedded in the custom id and replies "Only the chart creator can edit this
 * chart." to everyone else — and `chartSlashCommands` builds its author object
 * from `{ userNameLastFm, totalPlayCount }` alone, so the id is `undefined` at
 * runtime and the button refuses everybody. A control that can only fail is not a
 * control.
 */
describe('ChartBuilders: the Edit button is rendered only when it can work', () => {
  it('embeds a real creator id whenever the button is present', () => {
    const buttons = editButton(ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings()));
    expect(buttons).toHaveLength(1);
    const creatorId = buttons[0]?.custom_id?.split(':')[1];
    expect(creatorId).toBe('100000000000000001');
    expect(creatorId).not.toBe('undefined');
  });

  it('renders no button at all when the author object carries no Discord id', () => {
    const response = ChartBuilders.buildAlbumChartResponse(userWithoutCreator, undefined, result(), settings());
    expect(editButton(response)).toEqual([]);
    expect(JSON.stringify(json(response).components)).not.toContain('chart-edit');
  });

  it('renders no button when the author id is not a Discord snowflake', () => {
    // A placeholder string is not an id: `interaction.user.id` can never equal it,
    // so the handler would refuse every press just the same.
    const response = ChartBuilders.buildAlbumChartResponse(
      { ...user, discordUserId: 'discord-1' },
      undefined,
      result(),
      settings(),
    );
    expect(editButton(response)).toEqual([]);
  });

  it('still sends the scrobble line as a plain text block, since a Section needs an accessory', () => {
    // The honest no-button shape must still serialise, and must not lose the line
    // in the process.
    const response = ChartBuilders.buildAlbumChartResponse(userWithoutCreator, undefined, result(), settings());
    expect(() => json(response)).not.toThrow();
    expect(scrobbleLine(response)).toContain('-# listener has 188,022 scrobbles');
  });

  it('serialises with and without a creator id and with and without a play count', () => {
    const { totalPlayCount: _ignored, ...withoutCount } = user;
    for (const author of [user, userWithoutCreator, { ...user, discordUserId: 'discord-1' }, withoutCount as User]) {
      expect(() => json(ChartBuilders.buildAlbumChartResponse(author, undefined, result(), settings()))).not.toThrow();
    }
  });
});
