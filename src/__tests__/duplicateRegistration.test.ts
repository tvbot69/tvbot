import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT } from '../testSupport/repoRoot';
import { Logger } from '@domain/logging/logger';
import {
  BROADCAST_PATCH_WARN_AFTER,
  getBroadcastShardFailureCount,
  patchWebSocketBroadcast,
  resetBroadcastShardFailureCountForTest,
  selfTestBroadcastPatch,
} from '@bot/startup';

/**
 * One token, one write. tsyringe last-write-wins silently, so a second
 * registerInstance for the same token swaps the instance with no error and no
 * log. Twelve such pairs lived in startup.ts (same variable twice); the fix
 * keeps the first write. This test reads the source and fails on ANY duplicate.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
  resetBroadcastShardFailureCountForTest();
});

describe('no duplicate container registrations', () => {
  it('registers every token exactly once in startup.ts', () => {
    const src = readFileSync(join(SRC_ROOT, 'bot', 'startup.ts'), 'utf8');
    const re = /registerInstance(?:<[^>]+>)?\(\s*([^,]+?),/g;
    const tokens: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const token = (m[1] ?? '').trim();
      if (token) tokens.push(token);
    }
    // Guard against the scan passing vacuously on an empty match.
    expect(tokens.length).toBeGreaterThan(150);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([t]) => t);
    expect(dupes, 'duplicate registerInstance tokens (last write wins silently)').toEqual([]);
  });
});

describe('broadcast patch shape gate', () => {
  it('self-test passes on the current discord.js shape', () => {
    expect(selfTestBroadcastPatch()).toBe(true);
  });

  it('skips patch on shape mismatch with WARN and keeps native broadcast', () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const native = (): void => undefined;
    const badShapes: unknown[] = [
      null,
      {},
      { broadcast: native },
      { broadcast: native, shards: new Map(), _ws: {} },
      { broadcast: native, shards: new Map(), _ws: { send: 'nope' } },
      { broadcast: 'nope', shards: new Map(), _ws: { send: () => undefined } },
    ];
    for (const shape of badShapes) {
      resetBroadcastShardFailureCountForTest();
      expect(patchWebSocketBroadcast(shape)).toBe(false);
    }
    expect(Logger.warn).toHaveBeenCalled();
    expect(native).toBeDefined();
  });

  it('patches the real pre-connect shape (_ws absent) and skips quiet', () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    resetBroadcastShardFailureCountForTest();
    const fake = {
      broadcast(_packet: unknown): void {
        // Replaced by the patch under test.
      },
      shards: new Map<number, unknown>([[0, {}]]),
      _ws: null,
    };
    expect(patchWebSocketBroadcast(fake)).toBe(true);
    expect(() => (fake.broadcast as (packet: unknown) => void)({ op: 1 })).not.toThrow();
    expect(debug).toHaveBeenCalled();
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  it('fans out per shard on a valid shape', () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    resetBroadcastShardFailureCountForTest();
    const send = vi.fn((_shardId: number, _packet: unknown) => Promise.resolve('ok'));
    const fake = {
      broadcast(_packet: unknown): void {
        throw new Error('native should have been replaced');
      },
      shards: new Map<number, unknown>([
        [0, {}],
        [1, {}],
      ]),
      _ws: { send },
    };
    expect(patchWebSocketBroadcast(fake)).toBe(true);
    const packet = { op: 1 };
    (fake.broadcast as (packet: unknown) => void)(packet);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(0, packet);
    expect(send).toHaveBeenCalledWith(1, packet);
  });
});

describe('broadcast failure counter', () => {
  it('stays at debug below the threshold and warns on repeated failure', async () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    resetBroadcastShardFailureCountForTest();
    const send = vi.fn((_shardId: number, _packet: unknown) => Promise.reject(new Error('down')));
    const fake = {
      broadcast(_packet: unknown): void {
        // Replaced by the patch under test.
      },
      shards: new Map<number, unknown>([[0, {}]]),
      _ws: { send },
    };
    expect(patchWebSocketBroadcast(fake)).toBe(true);
    const patched = fake.broadcast as (packet: unknown) => void;

    patched({ op: 1 });
    await flush();
    expect(getBroadcastShardFailureCount()).toBe(1);
    expect(debug).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    for (let i = 1; i < BROADCAST_PATCH_WARN_AFTER; i += 1) {
      patched({ op: 1 });
      await flush();
    }
    expect(getBroadcastShardFailureCount()).toBeGreaterThanOrEqual(BROADCAST_PATCH_WARN_AFTER);
    expect(warn).toHaveBeenCalled();
  });

  it('counts a synchronous send throw and resets on success', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    resetBroadcastShardFailureCountForTest();
    let mode = 'throw';
    const send = vi.fn((_shardId: number, _packet: unknown): unknown => {
      if (mode === 'throw') throw new Error('sync boom');
      return Promise.resolve('ok');
    });
    const fake = {
      broadcast(_packet: unknown): void {
        // Replaced by the patch under test.
      },
      shards: new Map<number, unknown>([[0, {}]]),
      _ws: { send },
    };
    expect(patchWebSocketBroadcast(fake)).toBe(true);
    const patched = fake.broadcast as (packet: unknown) => void;

    patched({ op: 1 });
    expect(getBroadcastShardFailureCount()).toBe(1);

    mode = 'ok';
    patched({ op: 1 });
    await flush();
    expect(getBroadcastShardFailureCount()).toBe(0);
  });
});
