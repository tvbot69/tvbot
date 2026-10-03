import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import {
  ensureLinkedUser,
  SLASH_UNLINKED_MESSAGE,
  textUnlinkedMessage,
} from '@bot/handlers/commands/commandGuards';

const mkUser = (over: Record<string, unknown> = {}) => ({
  userId: 1,
  userNameLastFm: 'DreadRock',
  discordUserId: '111',
  registeredOn: new Date(),
  userType: 'User',
  dataSource: 'LastFm',
  privacyLevel: 0,
  ...over,
});

describe('ensureLinkedUser', () => {
  it('passes a linked user through', async () => {
    const userService = { getUserByDiscordId: vi.fn(async () => mkUser()) };
    const result = await ensureLinkedUser(userService as never, '111', { slash: true });
    expect(result).toEqual(expect.objectContaining({ userId: 1, userNameLastFm: 'DreadRock' }));
    expect(result instanceof ResponseModel).toBe(false);
  });

  it('unlinked slash caller gets the /register message', async () => {
    const userService = { getUserByDiscordId: vi.fn(async () => null) };
    const result = await ensureLinkedUser(userService as never, '111', { slash: true });
    expect(result instanceof ResponseModel).toBe(true);
    const response = result as ResponseModel;
    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(response.embed.data.description).toBe(SLASH_UNLINKED_MESSAGE);
    expect(response.embed.data.description).toContain('Use `/register` first');
  });

  it('unlinked text caller gets the prefix-aware message', async () => {
    const userService = { getUserByDiscordId: vi.fn(async () => null) };
    const result = await ensureLinkedUser(userService as never, '111', { prefix: '!' });
    expect(result instanceof ResponseModel).toBe(true);
    expect((result as ResponseModel).embed.data.description).toBe(textUnlinkedMessage('!'));
    expect((result as ResponseModel).embed.data.description).toContain('`!register`');
  });

  it('treats an empty Last.fm name as unlinked', async () => {
    const userService = { getUserByDiscordId: vi.fn(async () => mkUser({ userNameLastFm: '' })) };
    const result = await ensureLinkedUser(userService as never, '111', { slash: true });
    expect(result instanceof ResponseModel).toBe(true);
    expect((result as ResponseModel).commandResponse).toBe(CommandResponse.NotFound);
  });

  it('defaults a missing prefix to dot', async () => {
    const userService = { getUserByDiscordId: vi.fn(async () => null) };
    const result = await ensureLinkedUser(userService as never, '111');
    expect((result as ResponseModel).embed.data.description).toContain('`.register`');
  });
});
