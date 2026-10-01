import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { MusicInteractions } from '@bot/interactions/music/musicInteractions';

/**
 * musicInteractions was 31.03% with 400 uncovered lines and no tests.
 *
 * Two protections live here and both are easy to break by accident:
 *
 *  1. The DOUBLE-PRESS LOCK. Discord re-delivers an interaction when an ack
 *     takes too long, and users double-tap. Two near-simultaneous presses must
 *     never double-skip or toggle pause twice. The lock is per guild AND per
 *     button, so pressing skip then pause in quick succession is allowed -
 *     only a repeat of the SAME control is swallowed.
 *
 *  2. The REQUESTER GATE, and the deliberate policy that a queue with no
 *     requester (autoplay, 24/7) stays controllable by anyone. The catch there
 *     returns TRUE on error: if the permission service throws, the bot must not
 *     lock everybody out of their own music.
 */



const build = (over: Record<string, unknown> = {}) => {
  const musicService = {
    canControlPlayback: vi.fn(() => true),
    getQueueInfo: vi.fn(() => ({ current: { title: 'Airbag', artworkUrl: 'https://img/a.png' }, guildUsers: [], tracks: [] })),
    ...(over.musicService as object),
  };
  const colorService = { getAccentColorAsync: vi.fn(async () => undefined) };
  const lyricsService = {};
  const service = new MusicInteractions(musicService as never, colorService as never, lyricsService as never);
  return { service, musicService, colorService };
};

beforeEach(() => vi.restoreAllMocks());

describe('MusicInteractions.isRequesterAllowed', () => {
  const allow = (s: MusicInteractions, guild: string, user: string, admin = false) =>
    (s as unknown as { isRequesterAllowed(g: string, u: string, a?: boolean): boolean }).isRequesterAllowed(guild, user, admin);

  it('delegates to the shared permission check', () => {
    const { service, musicService } = build();
    allow(service, '222', '111', true);
    expect(musicService.canControlPlayback).toHaveBeenCalledWith('222', '111', true);
  });

  it('ALLOWS when the check throws, so nobody is locked out of their own bot', () => {
    // The safe failure is open, not closed: a throwing permission service
    // must not make the music unplayable for everyone.
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('service down');
    });
    expect(allow(service, '222', '111')).toBe(true);
  });
});

describe('MusicInteractions.memberIsAdmin', () => {
  const isAdmin = (s: MusicInteractions, v: unknown) =>
    (s as unknown as { memberIsAdmin(v: unknown): boolean }).memberIsAdmin(v);

  it('recognises an administrator', () => {
    const { service } = build();
    expect(isAdmin(service, { memberPermissions: { has: (p: bigint) => p === PermissionFlagsBits.Administrator } })).toBe(true);
  });

  it('recognises ManageGuild', () => {
    const { service } = build();
    expect(isAdmin(service, { memberPermissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild } })).toBe(true);
  });

  it('refuses a member with no permissions object', () => {
    const { service } = build();
    expect(isAdmin(service, {})).toBe(false);
  });

  it('refuses a member with unrelated permissions', () => {
    const { service } = build();
    expect(isAdmin(service, { memberPermissions: { has: () => false } })).toBe(false);
  });
});

describe('MusicInteractions.claimControlPress double-press lock', () => {
  const claim = (s: MusicInteractions, g: string, id: string) =>
    (s as unknown as { claimControlPress(g: string, i: string): boolean }).claimControlPress(g, id);

  it('allows the first press', () => {
    const { service } = build();
    expect(claim(service, '222', 'music:control:skip')).toBe(true);
  });

  it('swallows an immediate repeat of the same button', () => {
    // The whole point: Discord re-delivers a slow interaction, and a
    // double-tap must not double-skip.
    const { service } = build();
    claim(service, '222', 'music:control:skip');
    expect(claim(service, '222', 'music:control:skip')).toBe(false);
  });

  it('allows a DIFFERENT button in the same window', () => {
    // The lock is per guild AND per button, so skip then pause is two
    // deliberate actions, not a double press.
    const { service } = build();
    claim(service, '222', 'music:control:skip');
    expect(claim(service, '222', 'music:control:pause_resume')).toBe(true);
  });

  it('allows the same button in a DIFFERENT guild', () => {
    const { service } = build();
    claim(service, '222', 'music:control:skip');
    expect(claim(service, '999', 'music:control:skip')).toBe(true);
  });
});

describe('MusicInteractions.storeSearchResults', () => {
  it('stores results under the given key without throwing', () => {
    const { service } = build();
    expect(() => service.storeSearchResults('user-1', [])).not.toThrow();
  });
});
