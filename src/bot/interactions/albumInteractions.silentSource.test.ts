/**
 * `AlbumInteractions` acknowledged before it read, and then went silent on
 * every failure that happened after that acknowledgement.
 *
 * All three branches call `deferUpdate()` before `getAlbumById` /
 * `searchAlbum` - deliberately, so a slow source cannot blow Discord's 3s
 * window. But the catch at the top of `handleAlbumButton` was gated on
 *
 *     interaction.isRepliable() && !interaction.replied && !interaction.deferred
 *
 * and `deferUpdate` is exactly what makes `interaction.deferred` true. So the
 * one failure that most needed an answer - a press that failed halfway through
 * - was the only failure that got none. This is the regression
 * `interactionHandler.onInteractionCreated` documents at its own catch, where it
 * was fixed; the gate travelled with the pattern into these three files and
 * nobody carried the fix with it.
 *
 * The same handler also had three bare `if (!result) return;` after that defer.
 * `searchAlbum` returning `null` is an honest answer, and this file already
 * says so for the two misses above it ("Album record not found."); returning
 * instead meant the user could not tell "that album does not exist" from "the
 * button is broken", and the card they opened stayed on screen saying nothing
 * happened.
 *
 * BOTH DIRECTIONS, because the second is where a lazy fix goes wrong: reporting
 * a failure must not mean reporting one that never happened. A read that RAN and
 * found nothing still renders the card, and a plain driver failure still gets
 * the generic sentence rather than a source name it has not earned.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { AlbumInteractions } from './albumInteractions';
import { AlbumBuilders } from '@bot/builders/albumBuilders';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { AlbumSearchResult } from '@bot/services/albumService';

const GUILD_ID = 'g1';
const CALLER_ID = 'caller1';
const TARGET_ID = 'target1';

const LFM_DOWN = (method: string): LastFmUnavailableError =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 503'));

const DB_DOWN = (method: string): SourceUnavailableError =>
  new SourceUnavailableError(method, new Error('connect ECONNREFUSED'), 'Database unavailable');

const makeUser = () =>
  ({ userId: 1, userNameLastFm: 'lfmuser', discordUserId: TARGET_ID, totalPlayCount: 42 }) as never;

const makeAlbumRecord = () => ({ albumId: 42, albumName: 'Kid A', artistName: 'Radiohead' });

const makeSearchResult = (): AlbumSearchResult => ({
  albumId: 42,
  albumName: 'Kid A',
  artistName: 'Radiohead',
  albumCoverUrl: 'https://cdn/kid-a.png',
  tracks: [{ name: 'Idioteque', durationSeconds: 310, playcount: 8, rank: 1 }],
  totalDurationSeconds: 310,
});

const V2 = { id: 10 } as never;

const BUILT = { isComponentsV2: true, componentsV2Container: V2 } as never;

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: GUILD_ID,
    user: { id: CALLER_ID, username: 'Caller', displayName: 'CoolCaller' },
    isRepliable: vi.fn(() => true),
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    isRepliable: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const albumService = {
    getAlbumById: vi.fn(async () => makeAlbumRecord()),
    searchAlbum: vi.fn(async () => makeSearchResult()),
    ...(over.albumService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    ...(over.userService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const ai = new AlbumInteractions(albumService as never, userService as never, colorService as never);
  return { ai, albumService, userService, colorService };
};

const EPHEMERAL = { content: 'Something went wrong processing this interaction.', flags: MessageFlags.Ephemeral };
const NOT_FOUND = { content: 'I could not find that album.', flags: MessageFlags.Ephemeral };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(AlbumBuilders, 'buildAlbumInfoResponse').mockReturnValue(BUILT);
  vi.spyOn(AlbumBuilders, 'buildAlbumTracksResponse').mockReturnValue(BUILT);
  vi.spyOn(AlbumBuilders, 'buildCoverResponse').mockReturnValue(BUILT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BRANCHES: Array<[string, string]> = [
  ['album-info', `album-info:42:${TARGET_ID}:${CALLER_ID}`],
  ['album-tracks', `album-tracks:42:${TARGET_ID}:${CALLER_ID}`],
  ['album-cover', `album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`],
];

describe('AlbumInteractions — a failure AFTER deferUpdate is still reported', () => {
  it.each(BRANCHES)('%s reports a database outage with a followUp, not silence', async (_label, customId) => {
    // This is the mutation target. The button double reports `deferred: true`,
    // which is the state the production handler has put it in by the time the
    // read throws - and the old `!interaction.deferred` gate made that state
    // suppress the answer entirely.
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => { throw DB_DOWN('albumRepository.getAlbumById'); }) } });
    const press = mkButton(customId, { deferred: true });

    await expect(ai.handleAlbumButton(press)).resolves.toBeUndefined();

    expect(press.followUp).toHaveBeenCalledWith(EPHEMERAL);
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it.each(BRANCHES)('%s reports a Last.fm outage from the search with a followUp', async (_label, customId) => {
    const { ai } = build({ albumService: { searchAlbum: vi.fn(async () => { throw LFM_DOWN('lastFmRepository.getAlbumInfo'); }) } });
    const press = mkButton(customId, { deferred: true });

    await expect(ai.handleAlbumButton(press)).resolves.toBeUndefined();

    expect(press.followUp).toHaveBeenCalledWith(EPHEMERAL);
  });

  it('answers with a plain reply when the ack guard has NOT deferred yet', async () => {
    // The 2.5s ack guard in interactionHandler races this handler, so the same
    // failure can arrive with the interaction still unacknowledged. `reply` is
    // the only verb Discord accepts then, and `followUp` would throw 40060.
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => { throw new Error('driver reset'); }) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith(EPHEMERAL);
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('uses followUp when the interaction was already answered rather than deferred', async () => {
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => { throw new Error('driver reset'); }) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, { replied: true });

    await ai.handleAlbumButton(press);

    expect(press.followUp).toHaveBeenCalledWith(EPHEMERAL);
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('does not build a card from a read that failed', async () => {
    const { ai } = build({ albumService: { searchAlbum: vi.fn(async () => { throw LFM_DOWN('lastFmRepository.getAlbumInfo'); }) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, { deferred: true });

    await ai.handleAlbumButton(press);

    expect(AlbumBuilders.buildAlbumInfoResponse).not.toHaveBeenCalled();
  });

  it('still says nothing at all to an interaction Discord will not accept', async () => {
    // The guard that is NOT the bug: a non-repliable interaction cannot be
    // answered by anyone, so the honest outcome is silence rather than a second
    // rejected send.
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => { throw new Error('driver reset'); }) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, {
      deferred: true,
      isRepliable: vi.fn(() => false),
    });

    await expect(ai.handleAlbumButton(press)).resolves.toBeUndefined();

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.followUp).not.toHaveBeenCalled();
  });
});

describe('AlbumInteractions — a null search result is an honest answer, said out loud', () => {
  it.each(BRANCHES)('%s says it could not find the album instead of returning silently', async (_label, customId) => {
    // The old test asserted the DEFER happened and no card was built, and
    // stopped there - which is how a silent return passed as correct. The point
    // of the replacement is the missing half: the user must be told.
    const { ai } = build({ albumService: { searchAlbum: vi.fn(async () => null) } });
    const press = mkButton(customId, { deferred: true });

    await ai.handleAlbumButton(press);

    expect(press.followUp).toHaveBeenCalledWith(NOT_FOUND);
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('distinguishes "no such album" from "that read failed"', async () => {
    // The pair in the strict sense: a `null` is the service's real answer and
    // must not be laundered into the same sentence a failure gets, or the two
    // become indistinguishable to the user.
    const { ai } = build({ albumService: { searchAlbum: vi.fn(async () => { throw new Error('driver reset'); }) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, { deferred: true });

    await ai.handleAlbumButton(press);

    expect(press.followUp).toHaveBeenCalledWith(EPHEMERAL);
    expect(press.followUp).not.toHaveBeenCalledWith(NOT_FOUND);
  });

  it('still renders the card when the read ran and found a real album', async () => {
    const { ai } = build();
    const press = mkButton(`album-tracks:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(AlbumBuilders.buildAlbumTracksResponse).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
    expect(press.followUp).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('still reports a genuinely missing album row with the pre-existing message', async () => {
    // Unchanged behaviour on the path that was already honest - the row lookup
    // happens before the defer, so a plain reply is correct here.
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => null) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Album record not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.followUp).not.toHaveBeenCalled();
  });
});
