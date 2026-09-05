import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLavalinkNodes } from '../../config/lavalink';

describe('Lavalink Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default public nodes when no environment variables are set', () => {
    delete process.env.LAVALINK_NODES;
    delete process.env.LAVALINK_BACKUP_HOST;

    const nodes = getLavalinkNodes();
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(nodes.some((n) => n.identifier.startsWith('Serenetia'))).toBe(true);
    expect(nodes.some((n) => n.identifier === 'MilloHost')).toBe(true);
  });

  it('merges custom LAVALINK_NODES from JSON env', () => {
    process.env.LAVALINK_NODES = JSON.stringify([
      {
        identifier: 'CustomNode1',
        host: 'lavalink.custom.com',
        port: 443,
        password: 'customPassword',
        secure: true,
      },
    ]);

    const nodes = getLavalinkNodes();
    expect(nodes.some((n) => n.identifier === 'CustomNode1')).toBe(true);
    const custom = nodes.find((n) => n.identifier === 'CustomNode1');
    expect(custom?.host).toBe('lavalink.custom.com');
  });

  it('adds backup node when LAVALINK_BACKUP_HOST is configured', () => {
    process.env.LAVALINK_BACKUP_HOST = 'backup.lava.link';
    process.env.LAVALINK_BACKUP_PORT = '80';
    process.env.LAVALINK_BACKUP_PASSWORD = 'backupPass';
    process.env.LAVALINK_BACKUP_SECURE = 'false';

    const nodes = getLavalinkNodes();
    const backup = nodes.find((n) => n.identifier === 'BackupNode');
    expect(backup).toBeDefined();
    expect(backup?.host).toBe('backup.lava.link');
    expect(backup?.port).toBe(80);
    expect(backup?.secure).toBe(false);
  });
});
