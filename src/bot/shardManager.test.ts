import { describe, it, expect } from 'vitest';
import { shouldShard } from './shardManager';

describe('shouldShard (Phase 2.1)', () => {
  it('stays single-process by default (Railway/dev behavior unchanged)', () => {
    expect(shouldShard({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldShard({ SHARDING_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldShard({ SHARD_COUNT: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('enables the manager when explicitly requested', () => {
    expect(shouldShard({ SHARDING_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldShard({ SHARD_COUNT: '4' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
