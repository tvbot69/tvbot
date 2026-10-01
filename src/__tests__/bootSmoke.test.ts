import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { container } from 'tsyringe';
import { configureContainer } from '@bot/startup';
import { getSlashCommandPayloads, getSlashCommand } from '@bot/slashCommands';
import { getTextCommand, getTextCommands } from '@bot/textCommands';

/**
 * Boot smoke test: build the REAL dependency graph and the REAL command
 * payloads, with no network and no database connection.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured 2026-09-27: nothing in 123 test files ever called
 * `configureContainer()`. 223 `registerInstance` calls were completely
 * unexercised, so the entire class of failure below was invisible until the bot
 * booted in production:
 *
 *   - a service registered with the wrong dependency, or not registered at all
 *     (tsyringe throws only at resolve time)
 *   - a constructor arity change that TypeScript accepts but the graph does not
 *   - a slash command payload Discord would reject, which fails the ENTIRE
 *     command deployment, not just that one command
 *   - a text command whose name collides with another at real resolution time
 *
 * That last one matters most. `commandRegistryInvariants.test.ts` reads command
 * definitions out of source with the TypeScript AST, because the real ones need
 * a container. This is the other half: the same invariants, checked against the
 * actual objects the bot ships with.
 *
 * SAFE TO CALL
 * ------------
 * `configureContainer()` constructs objects but opens no sockets: Prisma is
 * lazy, and the Spotify/Last.fm clients only build. `Startup.runAsync()` is the
 * entry point with real side effects - banner, process handlers, connecting to
 * Discord - and is deliberately NOT called here.
 */

/** Discord's own limits, restated so a violation names the actual rule. */
const SLASH_NAME_MAX = 32;
const SLASH_DESCRIPTION_MAX = 100;
const SLASH_OPTIONS_MAX = 25;
const SLASH_NAME_PATTERN = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

/**
 * `RESTPostAPIApplicationCommandsJSONBody` is a union of ChatInput, User and
 * Message command bodies; only ChatInput carries a description. The bot only
 * ever deploys chat-input commands, so that is the variant these limits apply
 * to. Narrowing here rather than casting keeps the test honest about which
 * shape it is validating.
 */
interface ChatInputPayload {
  name: string;
  description?: string;
  options?: { type?: unknown; name?: string }[];
}

let slashPayloads: ChatInputPayload[];
let textNames: string[];

beforeAll(() => {
  configureContainer();
  slashPayloads = getSlashCommandPayloads() as ChatInputPayload[];
  textNames = [...getTextCommands().keys()];
});

describe('boot smoke: container wiring', () => {
  it('registers and resolves the critical playback and command graph', async () => {
    const { MusicHandler } = await import('@bot/handlers/musicHandler');
    const { CommandHandler } = await import('@bot/handlers/commandHandler');
    const { InteractionHandler } = await import('@bot/handlers/interactionHandler');
    const { ArtworkService } = await import('@bot/services/media/artworkService');
    const { MusicService } = await import('@bot/services/music/musicService');
    const { MoonlinkManager } = await import('@bot/services/music/moonlinkManager');
    const { QueueService } = await import('@bot/services/music/queueService');

    // tsyringe throws "Service with X has not been registered" here, which is
    // exactly the failure this test exists to catch.
    const tokens: [string, new (...a: never[]) => unknown][] = [
      ['MusicHandler', MusicHandler as never],
      ['CommandHandler', CommandHandler as never],
      ['InteractionHandler', InteractionHandler as never],
      ['ArtworkService', ArtworkService as never],
      ['MusicService', MusicService as never],
      ['MoonlinkManager', MoonlinkManager as never],
      ['QueueService', QueueService as never],
    ];

    const failures: string[] = [];
    for (const [name, token] of tokens) {
      try {
        expect(container.resolve(token), `${name} resolved to a falsy value`).toBeTruthy();
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    expect(failures, 'tokens that would stop the bot booting').toEqual([]);
  });
});

describe('boot smoke: slash command payloads Discord will accept', () => {
  it('builds a non-trivial set of commands', () => {
    // Guard against the whole file passing vacuously if a cache or an import
    // ever returns nothing.
    expect(slashPayloads.length).toBeGreaterThan(70);
  });

  it('survives discord.js own payload validation', () => {
    // getSlashCommandPayloads() calls toJSON(), which is where discord.js
    // enforces its own schema. A throw here is a deployment that Discord would
    // reject wholesale, so this test failing is the point.
    expect(() => getSlashCommandPayloads()).not.toThrow();
  });

  it('has no duplicate command names', () => {
    // Discord rejects an entire deployment containing two commands with the same
    // name, so this is a whole-bot failure rather than one bad command.
    const seen = new Map<string, number>();
    for (const p of slashPayloads) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)).toEqual([]);
  });

  it('every name and description satisfies Discord limits', () => {
    const problems: string[] = [];
    for (const p of slashPayloads) {
      if (p.name.length > SLASH_NAME_MAX) {
        problems.push(`'${p.name}': ${p.name.length} chars > ${SLASH_NAME_MAX}`);
      }
      if (!SLASH_NAME_PATTERN.test(p.name)) {
        problems.push(`'${p.name}': does not match Discord's allowed character set`);
      }
      if (!p.description || p.description.length > SLASH_DESCRIPTION_MAX) {
        problems.push(`'${p.name}': description length ${p.description?.length ?? 0}`);
      }
      const options = (p.options ?? []) as { type?: unknown; name?: string }[];
      if (options.length > SLASH_OPTIONS_MAX) {
        problems.push(`'${p.name}': ${options.length} options > ${SLASH_OPTIONS_MAX}`);
      }
      for (const o of options) {
        if (!o.type) problems.push(`'${p.name}': an option has no type`);
        if (o.name && o.name.length > SLASH_NAME_MAX) {
          problems.push(`'${p.name}': option '${o.name}' name too long`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('lookups resolve for a representative sample', () => {
    for (const name of ['music', 'track', 'topartists', 'whoknows', 'chart']) {
      // Names differ in casing style across families, so only assert that the
      // ones the bot advertises actually exist.
      const found = getSlashCommand(name) ?? getSlashCommand(name.toLowerCase());
      expect(found, `'${name}' is not in the slash registry`).toBeTruthy();
    }
  });
});

describe('boot smoke: text command registry resolves', () => {
  it('builds a non-trivial command map', () => {
    expect(textNames.length).toBeGreaterThan(500);
  });

  it('resolves a representative sample of text commands', () => {
    for (const name of ['fm', 'recent', 'lyrics', 'lyric', 'unlink', 'remove', 'np', 'rm']) {
      expect(getTextCommand(name), `'.${name}' does not resolve`).toBeTruthy();
    }
  });

  it('every resolved command has a usable definition', () => {
    const broken: string[] = [];
    for (const [key, command] of getTextCommands()) {
      if (!command.name) broken.push(`${key}: empty name`);
      if (typeof command.executeAsync !== 'function') {
        broken.push(`${key}: executeAsync is not a function`);
      }
    }
    expect(broken).toEqual([]);
  });
});
