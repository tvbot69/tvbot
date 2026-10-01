import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { AlbumInteractions, ALBUM_BUTTON_PREFIXES } from '@bot/interactions/library/albumInteractions';
import { AlbumBuilders } from '@bot/builders/library/albumBuilders';
import type { AlbumSearchResult } from '@bot/services/library/albumService';

const GUILD_ID = 'g1';
const CALLER_ID = 'caller1';
const TARGET_ID = 'target1';

const makeUser = (over: Record<string, unknown> = {}) =>
  ({
    userId: 1,
    userNameLastFm: 'lfmuser',
    discordUserId: TARGET_ID,
    totalPlayCount: 42,
    ...over,
  }) as never;

const makeAlbumRecord = (over: Record<string, unknown> = {}) => ({
  albumId: 42,
  albumName: 'Kid A',
  artistName: 'Radiohead',
  ...over,
});

const makeSearchResult = (over: Partial<AlbumSearchResult> = {}): AlbumSearchResult => ({
  albumId: 42,
  albumName: 'Kid A',
  artistName: 'Radiohead',
  albumCoverUrl: 'https://cdn/kid-a.png',
  tracks: [
    { name: 'Everything In Its Right Place', durationSeconds: 251, playcount: 10, rank: 1 },
    { name: 'Idioteque', durationSeconds: 310, playcount: 8, rank: 2 },
  ],
  totalDurationSeconds: 561,
  ...over,
});

const makeContainerResponse = (commandResponse = 'Ok') =>
  ({
    commandResponse,
    isComponentsV2: true,
    componentsV2Container: { id: 10, toJSON: () => ({ type: 17, id: 10 }) },
  }) as never;

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
    update: ReturnType<typeof vi.fn>;
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

/** Defaults every builder to a Components V2 response so routing assertions stay readable. */
const spyAllBuilders = (over: Record<string, unknown> = {}) => {
  const info = vi.spyOn(AlbumBuilders, 'buildAlbumInfoResponse').mockReturnValue(
    makeContainerResponse(over.infoCommandResponse as never),
  );
  const tracks = vi.spyOn(AlbumBuilders, 'buildAlbumTracksResponse').mockReturnValue(
    makeContainerResponse(over.tracksCommandResponse as never),
  );
  const cover = vi.spyOn(AlbumBuilders, 'buildCoverResponse').mockReturnValue(
    makeContainerResponse(over.coverCommandResponse as never),
  );
  return { info, tracks, cover };
};

const editPayload = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AlbumInteractions.handleAlbumButton — customId routing', () => {
  it('routes album-info to the info response', async () => {
    const { ai, albumService, userService } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(spies.tracks).not.toHaveBeenCalled();
    expect(spies.cover).not.toHaveBeenCalled();
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith(TARGET_ID);
    expect(albumService.getAlbumById).toHaveBeenCalledWith(42);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('routes album-tracks to the tracks response', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-tracks:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(spies.tracks).toHaveBeenCalledTimes(1);
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.cover).not.toHaveBeenCalled();
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('routes album-cover to the cover response', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`);

    await ai.handleAlbumButton(press);

    expect(spies.cover).toHaveBeenCalledTimes(1);
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.tracks).not.toHaveBeenCalled();
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an unrecognised customId', async () => {
    const { ai, albumService, userService } = build();
    const spies = spyAllBuilders();
    const press = mkButton('something-else:42');

    await ai.handleAlbumButton(press);

    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.tracks).not.toHaveBeenCalled();
    expect(spies.cover).not.toHaveBeenCalled();
    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(albumService.getAlbumById).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('exports exactly the three prefixes the handler understands', () => {
    expect(ALBUM_BUTTON_PREFIXES).toEqual(['album-info:', 'album-tracks:', 'album-cover:']);
  });
});

describe('AlbumInteractions — user resolution', () => {
  it('falls back to the interaction user id when the target segment is empty', async () => {
    const { ai, userService } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42::${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith(CALLER_ID);
  });

  it('replies ephemeral and stops when the user is not registered', async () => {
    const { ai, albumService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton(`album-info:42:unknown:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'User profile not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(albumService.getAlbumById).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral for an unregistered user on the tracks branch', async () => {
    const { ai } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton(`album-tracks:42:unknown:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'User profile not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral for an unregistered user on the cover branch', async () => {
    const { ai } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton(`album-cover:42:unknown:${CALLER_ID}:motion`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'User profile not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });
});

describe('AlbumInteractions — album record resolution', () => {
  it('replies ephemeral and stops when the album record is missing', async () => {
    const { ai, albumService } = build({ albumService: { getAlbumById: vi.fn(async () => null) } });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(albumService.getAlbumById).toHaveBeenCalledWith(42);
    expect(press.reply).toHaveBeenCalledWith({
      content: 'Album record not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(albumService.searchAlbum).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral for a missing album record on the tracks branch', async () => {
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => null) } });
    const press = mkButton(`album-tracks:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Album record not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral for a missing album record on the cover branch', async () => {
    const { ai } = build({ albumService: { getAlbumById: vi.fn(async () => null) } });
    const press = mkButton(`album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`);

    await ai.handleAlbumButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Album record not found.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('searches using the "artist | album" query built from the record', async () => {
    const { ai, albumService } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(albumService.searchAlbum).toHaveBeenCalledWith(
      'Radiohead | Kid A',
      expect.objectContaining({ userNameLastFm: 'lfmuser' }),
      GUILD_ID,
    );
  });
});

describe('AlbumInteractions — search result not found', () => {
  it.each([
    ['album-info', `album-info:42:${TARGET_ID}:${CALLER_ID}`],
    ['album-tracks', `album-tracks:42:${TARGET_ID}:${CALLER_ID}`],
    ['album-cover', `album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`],
  ])('deferUpdate, build nothing, and SAY the album was not found on the %s branch', async (_label, customId) => {
    // REPLACED. This used to be `defers then returns silently for a null result`
    // and asserted only the defer and the absence of a card - so the missing
    // half, that the user was told nothing at all, was invisible to it. A
    // `null` from `searchAlbum` is a real answer, and this file already answers
    // the two neighbouring misses out loud ("Album record not found.").
    const { ai } = build({ albumService: { searchAlbum: vi.fn(async () => null) } });
    const spies = spyAllBuilders();
    const press = mkButton(customId, { deferred: true });

    await ai.handleAlbumButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.followUp).toHaveBeenCalledWith({
      content: 'I could not find that album.',
      flags: MessageFlags.Ephemeral,
    });
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.tracks).not.toHaveBeenCalled();
    expect(spies.cover).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });
});

describe('AlbumInteractions — response building', () => {
  it('passes the search result, user, requester name and accent colour to the info builder', async () => {
    const { ai, userService } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    const user = await userService.getUserByDiscordId.mock.results[0]!.value;
    expect(spies.info).toHaveBeenCalledWith(
      expect.objectContaining({ albumName: 'Kid A' }),
      user,
      'CoolCaller',
      0xff0000,
    );
  });

  it('passes page 1 to the tracks builder when the customId has no page segment', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-tracks:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(spies.tracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'CoolCaller',
      1,
      0xff0000,
    );
  });

  it('passes the requested page to the tracks builder', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-tracks:42:${TARGET_ID}:${CALLER_ID}:3`);

    await ai.handleAlbumButton(press);

    expect(spies.tracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'CoolCaller',
      3,
      0xff0000,
    );
  });

  it('falls back to page 1 for a non-numeric page token', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-tracks:42:${TARGET_ID}:${CALLER_ID}:abc`);

    await ai.handleAlbumButton(press);

    expect(spies.tracks.mock.calls[0]![3]).toBe(1);
  });

  it('passes the result to the cover builder', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`);

    await ai.handleAlbumButton(press);

    expect(spies.cover).toHaveBeenCalledWith(
      expect.objectContaining({ artistName: 'Radiohead' }),
      expect.anything(),
      'CoolCaller',
      0xff0000,
    );
  });

  it('falls back to the Last.fm name when the interaction user has no displayName', async () => {
    const { ai } = build();
    const spies = spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, {
      user: { id: CALLER_ID, username: 'caller', displayName: '' },
    });

    await ai.handleAlbumButton(press);

    expect(spies.info.mock.calls[0]![2]).toBe('lfmuser');
  });

  it('looks the accent colour up by the target discord id', async () => {
    const { ai, colorService } = build();
    spyAllBuilders();
    const press = mkButton(`album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`);

    await ai.handleAlbumButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith(TARGET_ID);
  });

  it('looks the accent colour up by the caller id when the target segment is empty', async () => {
    const { ai, colorService } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42::${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith(CALLER_ID);
  });

  it('edits the reply with the container and the Components V2 flag', async () => {
    const { ai } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    const payload = editPayload(press.editReply);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toEqual([
      expect.objectContaining({ id: 10 }),
    ]);
  });

  it('defers the update before the slow album search', async () => {
    const { ai } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await ai.handleAlbumButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.reply).not.toHaveBeenCalled();
  });

  it.each([
    ['info', 'buildAlbumInfoResponse', `album-info:42:${TARGET_ID}:${CALLER_ID}`],
    ['tracks', 'buildAlbumTracksResponse', `album-tracks:42:${TARGET_ID}:${CALLER_ID}`],
    ['cover', 'buildCoverResponse', `album-cover:42:${TARGET_ID}:${CALLER_ID}:motion`],
  ])('skips the edit when the %s response has no container', async (_label, method, customId) => {
    const { ai } = build();
    vi.spyOn(AlbumBuilders, method as 'buildAlbumInfoResponse').mockReturnValue({
      isComponentsV2: false,
      buildEmbed: () => ['embed'],
      buildComponents: () => ['row'],
    } as never);
    const press = mkButton(customId);

    await ai.handleAlbumButton(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('continues when deferUpdate rejects', async () => {
    const { ai, albumService } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, {
      deferUpdate: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ai.handleAlbumButton(press);

    expect(albumService.searchAlbum).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });
});

describe('AlbumInteractions.handleAlbumButton — error path', () => {
  it('replies ephemeral with a generic message when the handler throws', async () => {
    const { ai } = build({
      albumService: {
        getAlbumById: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`);

    await expect(ai.handleAlbumButton(press)).resolves.toBeUndefined();

    expect(press.isRepliable).toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('does not reply when the interaction is not repliable', async () => {
    const { ai } = build({
      albumService: {
        getAlbumById: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, {
      isRepliable: vi.fn(() => false),
    });

    await ai.handleAlbumButton(press);

    expect(press.reply).not.toHaveBeenCalled();
  });

  it('uses followUp when the interaction was already replied to', async () => {
    // REPLACED, same reason as the deferred case above: "not `reply`" was
    // satisfied by saying nothing. An answered interaction is still answerable
    // once, via followUp.
    const { ai } = build({
      albumService: {
        getAlbumById: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, { replied: true });

    await ai.handleAlbumButton(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('reports a post-defer failure with followUp instead of going silent', async () => {
    // REPLACED. This used to read `does not reply when the interaction was
    // already deferred` and asserted only that `reply` was not called, which
    // silence satisfies just as well as a followUp. The state it built
    // (`deferred: true`) is exactly what `handleAlbumInfo` sets before it
    // reads, so the assertion was pinning "a failed read produces no message".
    const { ai } = build({
      albumService: {
        getAlbumById: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, { deferred: true });

    await ai.handleAlbumButton(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('swallows an error raised by the ephemeral fallback reply itself', async () => {
    const { ai } = build({
      albumService: {
        getAlbumById: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, {
      reply: vi.fn(async () => {
        throw new Error('Missing Access');
      }),
    });

    await expect(ai.handleAlbumButton(press)).resolves.toBeUndefined();

    expect(press.reply).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a second ack when editReply fails after the interaction was deferred', async () => {
    const { ai } = build();
    spyAllBuilders();
    const press = mkButton(`album-info:42:${TARGET_ID}:${CALLER_ID}`, {
      deferred: true,
      editReply: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

    await expect(ai.handleAlbumButton(press)).resolves.toBeUndefined();

    expect(press.editReply).toHaveBeenCalledTimes(1);
    expect(press.reply).not.toHaveBeenCalled();
  });
});
