import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MusicSlashCommands } from './musicSlashCommands';

// Discord caps a command at 25 options and subcommands count as options.
// Exceeding it used to crash shard startup (shapeshift "Invalid Array
// length" in addSubcommand) — construction is the guardrail.
const makeModule = () =>
  new MusicSlashCommands(
    {} as never,
    { getAccentColorAsync: async () => 0xff0000 } as never,
  );

describe('MusicSlashCommands registration payload', () => {
  it('keeps every command within the 25-option cap', () => {
    const mod = makeModule();
    for (const cmd of mod.commands) {
      const json = cmd.data.toJSON();
      expect(json.options?.length ?? 0).toBeLessThanOrEqual(25);
    }
  });

  it('exposes /music at the cap with chapters, and /nodes standalone', () => {
    const mod = makeModule();
    expect(mod.commands).toHaveLength(2);

    const music = mod.commands[0]!.data.toJSON();
    expect(music.name).toBe('music');
    const subNames = (music.options ?? []).map((o) => o.name);
    expect(subNames).toHaveLength(25);
    expect(subNames).toContain('chapters');
    expect(subNames).not.toContain('resume');
    expect(subNames).not.toContain('nodes');

    expect(mod.commands[1]!.data.toJSON().name).toBe('nodes');
  });
});
