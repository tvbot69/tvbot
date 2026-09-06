import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { ShortcutService } from './shortcutService';

describe('ShortcutService', () => {
  let service: ShortcutService;

  beforeEach(() => {
    service = new ShortcutService();
  });

  it('sets and retrieves user shortcuts', () => {
    service.setShortcut('u1', 'mytop', 'top artists 1m');
    service.setShortcut('u1', 'bestie', 'fm @friend');

    const shortcuts = service.getShortcuts('u1');
    expect(shortcuts).toHaveLength(2);
    expect(shortcuts).toEqual(
      expect.arrayContaining([
        { name: 'mytop', command: 'top artists 1m' },
        { name: 'bestie', command: 'fm @friend' },
      ]),
    );
  });

  it('resolves shortcut input cleanly stripping prefixes', () => {
    service.setShortcut('u1', '.mytop', '.top artists 1m');

    expect(service.resolveShortcut('u1', 'mytop')).toBe('top artists 1m');
    expect(service.resolveShortcut('u1', '.mytop')).toBe('top artists 1m');
    expect(service.resolveShortcut('u1', 'unknown')).toBeNull();
  });

  it('removes a shortcut', () => {
    service.setShortcut('u1', 'mytop', 'top artists 1m');
    const removed = service.removeShortcut('u1', 'mytop');

    expect(removed).toBe(true);
    expect(service.getShortcuts('u1')).toHaveLength(0);
    expect(service.resolveShortcut('u1', 'mytop')).toBeNull();
  });
});
