/**
 * `CommandDispatcher.dispatchResponse` — how a command's response actually
 * reaches Discord, plus `ensureBotPermissions` and the referenced-music store.
 *
 * `commandDispatcher.silentSource.test.ts` already owns `handleCommandException`
 * and the source-vs-defect wording. This file owns delivery, and delivery is where
 * a user who asked a question can get NOTHING back for reasons that have nothing
 * to do with their question:
 *
 *  1. Permissions. Missing Send Messages means one WARN line and silence;
 *     missing Embed Links means a plain-text sentence instead of the card, which
 *     is the difference between "the bot is broken" and "the bot told me".
 *  2. A send that Discord rejects. The first attempt failing is reported by a
 *     SECOND send, because silence is the worst outcome: the user typed a command
 *     and got nothing at all, with no hint that anything happened. A 50035 gets a
 *     different sentence from any other failure, because it means the payload was
 *     too large and the user's next move is different.
 *  3. The in-place edit path. A repeat of the same message edits the bot's
 *     previous card instead of posting a second one — and when that edit cannot
 *     happen (the message was deleted, the bot lost permission), the card still
 *     goes out as a fresh send.
 *
 * `CommandDispatcher` is never spied on. It is a static-only class whose two
 * public entry points ARE the behaviour under test, and `vi.spyOn` on a static
 * leaves an own property behind for every later test in the file. The real
 * dispatch path runs against plain-object channel doubles.
 *
 * The referenced-music and edit-in-place maps are module-level statics, so every
 * test here uses a distinct message id. The pruning test deliberately fills the
 * music map to its cap, which is why it is last.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CommandDispatcher } from '../commandDispatcher';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { Message, TextBasedChannel } from 'discord.js';

let seq = 0;

const textResponse = (content: string): ResponseModel => {
  const response = new ResponseModel();
  response.setContent(content);
  return response;
};

interface PermissionsDouble {
  has: (bit: bigint) => boolean;
}

const permissions = (allowed: bigint[]): PermissionsDouble => ({
  has: vi.fn((bit: bigint) => allowed.includes(bit)),
});

/**
 * `ensureBotPermissions` calls `permissionsFor` on the CHANNEL (it holds the
 * guild channel API), passing it the bot member it read off `channel.guild`.
 * So the double has to hang that method on the channel, not on the guild.
 */
const buildMessage = (
  opts: {
    guildId?: string | null;
    guild?: unknown;
    content?: string;
    permissionsFor?: (member: unknown) => PermissionsDouble | null;
  } = {},
) => {
  seq += 1;
  const sent = vi.fn(async (..._args: unknown[]) => ({ id: `sent-${seq}` }));
  const channel: Record<string, unknown> = {
    isTextBased: () => true,
    sendTyping: vi.fn(async () => undefined),
    name: 'general',
  };
  if (opts.guild !== undefined) channel.guild = opts.guild;
  if (opts.permissionsFor !== undefined) channel.permissionsFor = opts.permissionsFor;
  return {
    id: `message-${seq}`,
    content: opts.content ?? '.ping',
    guildId: opts.guildId === undefined ? 'g-1' : opts.guildId,
    author: { id: 'u-1', tag: 'u-1#0001', username: 'u-1', bot: false },
    guild: opts.guild ?? null,
    channel,
    delete: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
    reply: vi.fn(async () => ({ id: 'replied' })),
    sent,
  };
};

const attachSend = (message: ReturnType<typeof buildMessage>, send: (p: Record<string, unknown>) => Promise<unknown>) => {
  message.channel.send = send;
};

const sendCallPayload = (send: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> =>
  (send.mock.calls[index]?.[0] ?? {}) as Record<string, unknown>;

describe('CommandDispatcher.ensureBotPermissions', () => {
  const check = (channel: unknown, guildId?: string | null) =>
    CommandDispatcher.ensureBotPermissions(channel as TextBasedChannel, guildId);

  it('assumes everything is permitted in a DM, where there is no permission model', async () => {
    await expect(check({ send: () => undefined }, null)).resolves.toEqual({ canSend: true, canEmbed: true });
  });

  it('assumes everything is permitted for a channel that is not part of a guild', async () => {
    await expect(check({ send: () => undefined }, 'g-1')).resolves.toEqual({ canSend: true, canEmbed: true });
  });

  it('assumes everything is permitted while the bot member is not cached yet', async () => {
    // Right after login the member is not in the cache, and refusing to answer
    // then would silence the bot until the first cache warm-up.
    await expect(check({ guild: { members: {} } }, 'g-1')).resolves.toEqual({ canSend: true, canEmbed: true });
  });

  it('assumes everything is permitted when the permission calculation is unavailable', async () => {
    await expect(
      check({ guild: { members: { me: {} } }, permissionsFor: () => null }, 'g-1'),
    ).resolves.toEqual({ canSend: true, canEmbed: true });
  });

  it('reports the two permissions separately', async () => {
    const sendOnly = {
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => permissions([PermissionFlagsBits.SendMessages]),
    };
    const embedOnly = {
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => permissions([PermissionFlagsBits.EmbedLinks]),
    };
    const neither = {
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => permissions([]),
    };

    await expect(check(sendOnly, 'g-1')).resolves.toEqual({ canSend: true, canEmbed: false });
    await expect(check(embedOnly, 'g-1')).resolves.toEqual({ canSend: false, canEmbed: true });
    await expect(check(neither, 'g-1')).resolves.toEqual({ canSend: false, canEmbed: false });
  });

  it('passes the bot member to the permission calculation', async () => {
    const permissionsFor = vi.fn(() => permissions([PermissionFlagsBits.SendMessages]));
    await check({ guild: { members: { me: { id: 'bot' } } }, permissionsFor }, 'g-1');
    expect(permissionsFor).toHaveBeenCalledWith({ id: 'bot' });
  });
});

describe('CommandDispatcher.dispatchResponse: permissions', () => {
  const blockedMessage = (allowed: bigint[]) => {
    const message = buildMessage({
      guild: { name: 'G', shardId: 0, members: { me: { id: 'bot' } } },
      permissionsFor: () => permissions(allowed),
    });
    attachSend(message, message.sent);
    return message;
  };

  it('sends nothing at all when the bot cannot send messages', async () => {
    const message = blockedMessage([]);
    await CommandDispatcher.dispatchResponse(
      message as unknown as Message,
      textResponse('your card'),
      Date.now(),
      'ping',
    );
    expect(message.sent).not.toHaveBeenCalled();
  });

  it('sends a plain sentence, not the card, when the bot cannot embed', async () => {
    // The user gets told what is wrong and what to grant. Silence would look
    // exactly like a broken bot.
    const message = blockedMessage([PermissionFlagsBits.SendMessages]);
    const embed = new ResponseModel();
    embed.embed.setDescription('a card');
    await CommandDispatcher.dispatchResponse(message as unknown as Message, embed, Date.now(), 'ping');

    const payload = sendCallPayload(message.sent);
    expect((payload.content as string)).toContain('**Embed Links**');
    expect(payload.embeds).toBeUndefined();
  });

  it('sends a Components V2 card even without Embed Links, because it has no embed to downgrade', async () => {
    // The Embed Links complaint is only true for a response that would have been
    // an embed. A container renders through the message-content pipeline, so the
    // honest thing is to deliver it and say nothing about permissions.
    const message = blockedMessage([PermissionFlagsBits.SendMessages]);
    const response = new ResponseModel();
    response.setComponentsV2Container({ toJSON: () => ({ type: 17, components: [] }) } as never);

    await CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'ping');

    const payload = sendCallPayload(message.sent);
    expect(payload.components).toHaveLength(1);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(JSON.stringify(payload)).not.toContain('Embed Links');
  });
});

describe('CommandDispatcher.dispatchResponse: the payload', () => {
  const deliver = async (response: ResponseModel, opts: { guildId?: string | null } = {}) => {
    const message = buildMessage({ guildId: opts.guildId ?? null });
    attachSend(message, message.sent);
    await CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'ping');
    return { message, payload: sendCallPayload(message.sent) };
  };

  it('sends the content and no embeds at all for a plain text response', async () => {
    // The `embeds` key is DELETED rather than sent as an empty array: an empty
    // `embeds` array is a payload Discord has rejected in the past, and an absent
    // key is unambiguous.
    const { payload } = await deliver(textResponse('hello'));
    expect(payload.content).toBe('hello');
    expect(payload.embeds).toBeUndefined();
    expect('embeds' in payload).toBe(false);
  });

  it('sends the embeds and no content for an embed response', async () => {
    const response = new ResponseModel();
    response.embed.setDescription('a card');
    const { payload } = await deliver(response);
    expect(payload.content).toBeUndefined();
    expect((payload.embeds as unknown[]).length).toBe(1);
  });

  it('mirrors a legacy text-only builder into content when it also has an embed', async () => {
    const response = new ResponseModel();
    response.embed.setDescription('a card');
    response._textContent = 'plain mirror';
    const { payload } = await deliver(response);
    expect(payload.content).toBe('plain mirror');
    expect((payload.embeds as unknown[]).length).toBe(1);
  });

  it('never lets anyone be pinged by a command response', async () => {
    const { payload } = await deliver(textResponse('<@everyone> look at this'));
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('sends a Components V2 container with the right flag', async () => {
    const response = new ResponseModel();
    response.setComponentsV2Container({ toJSON: () => ({ type: 17, components: [] }) } as never);
    const { payload } = await deliver(response);
    expect(payload.components).toHaveLength(1);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.embeds).toBeUndefined();
  });

  it('attaches a single file to whichever payload shape it used', async () => {
    const withFile = new ResponseModel();
    withFile.setContent('here');
    withFile.setFile(Buffer.from('x'), 'chart.png');
    const plain = await deliver(withFile);
    expect((plain.payload.files as unknown[])?.length).toBe(1);

    const container = new ResponseModel();
    container.setComponentsV2Container({ toJSON: () => ({ type: 17, components: [] }) } as never);
    container.setFile(Buffer.from('x'), 'chart.png');
    const v2 = await deliver(container);
    expect((v2.payload.files as unknown[])?.length).toBe(1);
  });

  it('sends nothing at all for a deleted response', async () => {
    const response = new ResponseModel();
    response.commandResponse = CommandResponse.Deleted;
    response.setContent('should never be seen');
    const { message } = await deliver(response);
    expect(message.sent).not.toHaveBeenCalled();
  });
});

describe('CommandDispatcher.dispatchResponse: when Discord rejects the send', () => {
  const failing = (code: number | undefined) => {
    seq += 1;
    const sent = vi.fn(async (..._args: unknown[]) => {
      if (sent.mock.calls.length === 1) {
        throw Object.assign(new Error('discord said no'), code === undefined ? {} : { code });
      }
      return { id: `sent-${seq}` };
    });
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    return { message, sent };
  };

  it('reports a too-large payload as too large, because the next move is different', async () => {
    const { message, sent } = failing(50035);
    await expect(
      CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('big'), Date.now(), 'chart'),
    ).resolves.toBeUndefined();
    expect(sent).toHaveBeenCalledTimes(2);
    expect((sendCallPayload(sent, 1).content as string)).toContain('too large to display');
  });

  it('reports any other rejection without guessing at a cause', async () => {
    const { message, sent } = failing(50013);
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('card'), Date.now(), 'ping');
    expect((sendCallPayload(sent, 1).content as string)).toContain('could not display that result');
    expect((sendCallPayload(sent, 1).content as string)).not.toContain('too large');
  });

  it('reports a rejection that carries no error code at all', async () => {
    const { message, sent } = failing(undefined);
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('card'), Date.now(), 'ping');
    expect((sendCallPayload(sent, 1).content as string)).toContain('could not display that result');
  });

  it('never mentions a user or a permission when it talks about a size problem', async () => {
    const { message, sent } = failing(50035);
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('big'), Date.now(), 'chart');
    expect((sendCallPayload(sent, 1).content as string)).not.toContain('u-1#0001');
  });
});

describe('CommandDispatcher.dispatchResponse: the in-place edit path', () => {
  const withHistory = async () => {
    const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'fresh-send' }));
    const edit = vi.fn(async (..._args: unknown[]) => ({ id: 'edited' }));
    const fetch = vi.fn(async (..._args: unknown[]) => ({ edit }));
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    message.channel.messages = { fetch };

    // One normal dispatch, so the map learns "this message was answered by
    // fresh-send". The second dispatch must edit rather than post again.
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('page 1'), Date.now(), 'ping');
    return { message, sent, edit, fetch };
  };

  it('edits the previous card instead of posting a second one for the same message', async () => {
    const { message, sent, edit, fetch } = await withHistory();
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('page 2'), Date.now(), 'ping');

    expect(fetch).toHaveBeenCalledWith('fresh-send');
    expect(edit).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('falls back to a fresh send when the previous card cannot be fetched', async () => {
    const { message, sent, fetch } = await withHistory();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Unknown Message'));
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('page 2'), Date.now(), 'ping');
    // Deleted or uneditable must not cost the user their card.
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('falls back to a fresh send when the edit itself is rejected', async () => {
    const { message, sent, edit } = await withHistory();
    (edit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Missing Permissions'));
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('page 2'), Date.now(), 'ping');
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('does not try to fetch anything for a message it has never answered', async () => {
    const message = buildMessage({ guildId: null });
    const fetch = vi.fn();
    attachSend(message, message.sent);
    message.channel.messages = { fetch };
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('card'), Date.now(), 'ping');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never posts twice when the channel cannot fetch at all', async () => {
    const message = buildMessage({ guildId: null });
    attachSend(message, message.sent);
    // No `messages` on the channel: `fetchableChannel` would throw, and the
    // history branch is only entered when the channel can fetch.
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('card'), Date.now(), 'ping');
    expect(message.sent).toHaveBeenCalledTimes(1);
  });
});

describe('CommandDispatcher.dispatchResponse: reactions, cleanup and the music store', () => {
  it('reacts to the delivered card for every requested emoji', async () => {
    const react = vi.fn(async (..._args: unknown[]) => undefined);
    seq += 1;
    const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-x', react }));
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    const response = textResponse('card');
    response.addReaction('✅', '👀');
    await CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'ping');
    expect(react).toHaveBeenCalledTimes(2);
  });

  it('deletes the card and the command after the requested delay, and never before', async () => {
    vi.useFakeTimers();
    try {
      const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-x', delete: vi.fn(async () => undefined) }));
      const message = buildMessage({ guildId: 'g-1' });
      attachSend(message, sent);
      const response = textResponse('card');
      response.autoDeleteSeconds = 4;

      await CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'ping');
      expect(message.delete).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3900);
      expect(message.delete).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(message.delete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not delete anything when the response asked for no delay', async () => {
    vi.useFakeTimers();
    try {
      const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-x', delete: vi.fn(async () => undefined) }));
      const message = buildMessage({ guildId: 'g-1' });
      attachSend(message, sent);
      await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('card'), Date.now(), 'ping');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(message.delete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records referenced music for the reply chain, for both message ids', async () => {
    const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-y' }));
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    const response = textResponse('card');
    response.setReferencedMusic({ artist: 'Radiohead', track: 'Creep' });

    await CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'nowplaying');

    expect(CommandDispatcher.getReferencedMusic(message.id)).toEqual({ artist: 'Radiohead', track: 'Creep' });
    expect(CommandDispatcher.getReferencedMusic('sent-y')).toEqual({ artist: 'Radiohead', track: 'Creep' });
  });

  it('records nothing for a response with no referenced music', async () => {
    const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-z' }));
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    await CommandDispatcher.dispatchResponse(message as unknown as Message, textResponse('card'), Date.now(), 'ping');
    expect(CommandDispatcher.getReferencedMusic('sent-z')).toBeUndefined();
  });

  it('records nothing for referenced music that names nothing', async () => {
    const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-w' }));
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    const response = textResponse('card');
    response.referencedMusic = {};
    await CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'ping');
    expect(CommandDispatcher.getReferencedMusic('sent-w')).toBeUndefined();
  });

  it('delivers the card even when it carries a paginator session that cannot be registered', async () => {
    // The session is registered through the container, which is empty here. The
    // card must still go out, and the failure must not escape into the caller's
    // catch — which would report a broken command for a bookkeeping problem.
    const sent = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-p' }));
    const message = buildMessage({ guildId: null });
    attachSend(message, sent);
    const response = textResponse('card');
    response._paginatorSession = { currentPage: 0, totalPages: 3 };

    await expect(
      CommandDispatcher.dispatchResponse(message as unknown as Message, response, Date.now(), 'whoknows'),
    ).resolves.toBeUndefined();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  /**
   * Last, on purpose: filling the music store to its cap evicts the oldest entry,
   * and that eviction is process-wide for the rest of this file.
   */
  it('evicts the oldest entry once the music store passes its cap', () => {
    for (let i = 0; i <= 5000; i++) {
      CommandDispatcher.setReferencedMusic(`prune-key-${i}`, { artist: `Artist ${i}` });
    }
    expect(CommandDispatcher.getReferencedMusic('prune-key-0')).toBeUndefined();
    expect(CommandDispatcher.getReferencedMusic('prune-key-5000')).toEqual({ artist: 'Artist 5000' });
  });
});