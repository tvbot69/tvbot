/**
 * `ChartBuilders` — the `.chart` album/artist/track cards and the
 * "not enough images" refusal.
 *
 * A chart card is almost entirely a claim about an IMAGE, and the two ways that
 * can go wrong are both here:
 *
 *  1. The scrobble count line. `(user.totalPlayCount ?? 0)` means an unread
 *     play count renders as "has 0 scrobbles". Recorded at the bottom of this
 *     file, not endorsed — a chart with no image and a scroble count of zero is
 *     two confident wrong claims stacked on one card.
 *  2. A `ChartResult` with neither `imageUrl` nor `buffer` produces a card with a
 *     heading, an edit button and no chart, and nothing on it says the render
 *     failed. That is a silent wrong answer about the user's listening, so it is
 *     asserted here as current behaviour and reported.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { ChartBuilders } from './chartBuilders';
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

const user: User = {
  userId: 3,
  userNameLastFm: 'listener',
  discordUserId: 'discord-1',
  registeredOn: new Date('2024-01-01T00:00:00Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  totalPlayCount: 188_022,
};

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
    expect(album[0]?.custom_id).toContain('chart-edit:discord-1:a:3x3:weekly:');
    expect(artist[0]?.custom_id).toContain('chart-edit:discord-1:r:3x3:weekly:');
    expect(track[0]?.custom_id).toContain('chart-edit:discord-1:t:3x3:weekly:');
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
    expect(texts(response)[0]).toContain('[3x3 weekly chart]');
  });

  it('sets the container accent only when one was supplied', () => {
    const accented = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings(), 0x2468ac);
    const plain = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(json(accented).accent_color).toBe(0x2468ac);
    expect(json(plain).accent_color).toBeUndefined();
  });
});

describe('ChartBuilders.buildNotEnoughAlbumsError', () => {
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

  it('treats the legacy boolean argument as "artists", which is what it always meant', () => {
    expect(desc(new NotEnoughAlbumsError(2, 9), true)).toContain('**2** artists');
  });

  it('says the images went missing to the filters only when they did', () => {
    const filtered = desc(new NotEnoughAlbumsError(4, 9, true));
    const notFiltered = desc(new NotEnoughAlbumsError(4, 9, false));
    expect(filtered).toContain('Not enough albums remained after filters or missing covers.');
    expect(filtered).toContain('Try disabling `skip`/`ns`');
    expect(notFiltered).toContain('Try a smaller chart size, or use a different time period like `weekly`');
    expect(notFiltered).not.toContain('after filters or missing covers');
  });

  it('marks itself as wrong input rather than as a failure, so the caller can re-prompt', () => {
    const response = ChartBuilders.buildNotEnoughAlbumsError(new NotEnoughAlbumsError(1, 9));
    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(response.isComponentsV2).toBe(false);
  });
});

/**
 * Recorded, not fixed: `totalPlayCount` is `number | undefined` on the user row,
 * and the `?? 0` in `applyV2Container` turns "we do not know" into "0
 * scrobbles", which is a measurement claim about the listener.
 */
describe('ChartBuilders: an unread play count becomes a printed zero', () => {
  it('prints 0 scrobbles when the user row has no stored total', () => {
    const { totalPlayCount: _ignored, ...withoutCount } = user;
    const response = ChartBuilders.buildAlbumChartResponse(withoutCount as User, undefined, result(), settings());
    expect(sectionTexts(response)).toContain('-# listener has 0 scrobbles');
  });

  it('still prints the real total when one is stored, so the zero is only the fallback', () => {
    const response = ChartBuilders.buildAlbumChartResponse(user, undefined, result(), settings());
    expect(sectionTexts(response)).toContain('-# listener has 188,022 scrobbles');
  });
});
