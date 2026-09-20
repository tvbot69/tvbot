import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import { MoonlinkManager } from './moonlinkManager';

const SAVED_ENV = { ...process.env };

afterEach(() => {
  process.env.ENVIRONMENT = SAVED_ENV.ENVIRONMENT;
  if (SAVED_ENV.ENABLE_LAVALINK === undefined) {
    delete process.env.ENABLE_LAVALINK;
  } else {
    process.env.ENABLE_LAVALINK = SAVED_ENV.ENABLE_LAVALINK;
  }
});

describe('MoonlinkManager enablement', () => {
  it('explicit false disables music even in production', () => {
    process.env.ENVIRONMENT = 'production';
    process.env.ENABLE_LAVALINK = 'false';
    const manager = new MoonlinkManager();
    expect(manager.hasHealthyNode()).toBe(false);
    expect(manager.getHealthyNodeCount()).toBe(0);
    expect(manager.getNodeStats()).toEqual([]);
  });

  it('production without a flag enables the node pool', () => {
    process.env.ENVIRONMENT = 'production';
    delete process.env.ENABLE_LAVALINK;
    const manager = new MoonlinkManager();
    expect(manager.getManager()).toBeDefined();
    // Not connected in unit test, but the pool is configured
    expect(manager.getHealthyNodeCount()).toBe(0);
  });

  it('local dev stays dark unless explicitly enabled', () => {
    process.env.ENVIRONMENT = 'local';
    delete process.env.ENABLE_LAVALINK;
    const manager = new MoonlinkManager();
    expect(manager.hasHealthyNode()).toBe(false);
  });
});
