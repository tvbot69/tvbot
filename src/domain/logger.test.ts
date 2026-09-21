import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from './logger';

describe('CustomLogger context preservation', () => {
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lines = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  it('prints context fields alongside the message (pino-style)', () => {
    Logger.warn(
      { guildId: 'g1', track: 'Esme', severity: 'common', reason: 'blocked' },
      'Track failed — looking...',
    );
    const out = lines.join('\n');
    expect(out).toContain('Track failed');
    expect(out).toContain('g1');
    expect(out).toContain('Esme');
    expect(out).toContain('common');
    expect(out).toContain('blocked');
  });

  it('prints error stacks plus context on error level', () => {
    const err = new Error('kaboom');
    Logger.error({ err, guildId: 'g2' }, 'Something broke');
    const out = lines.join('\n');
    expect(out).toContain('Something broke');
    expect(out).toContain('g2');
    expect(out).toContain('kaboom');
    expect(out).toContain('at ');
  });

  it('leaves plain string logs untouched', () => {
    Logger.info('Just a message');
    expect(lines.join('\n')).toContain('Just a message');
  });

  it('does not duplicate err into the context dump', () => {
    const err = new Error('x');
    Logger.warn({ err, guildId: 'g3' }, 'Warn with err');
    const out = lines.join('\n');
    expect(out).toContain('g3');
    expect(out).not.toMatch(/err:\s*Error/);
  });
});
