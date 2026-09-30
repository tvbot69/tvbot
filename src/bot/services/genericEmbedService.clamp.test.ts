import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GenericEmbedService } from './genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';

/**
 * Every user-supplied string that reaches a Discord embed goes through here.
 *
 * The reason this module exists is that `EmbedBuilder.setDescription` ASSERTS a
 * length of 1..4096 and THROWS on a violation - the builders package runs with
 * validation on. So an over-long title, a 240-character search query pasted
 * into a template, or a track name with an absurd amount of trailing metadata
 * crashed the command rather than rendering. A clamp that returns '' would be
 * just as bad: the same assert rejects a zero-length description, and a command
 * that throws a different error is still a command that throws.
 *
 * These assertions therefore check the boundary from both sides, because the
 * off-by-one at exactly 4096 is the whole failure mode.
 */

const desc = (response: { embed: { data: { description?: string } } }): string =>
  response.embed.data.description as string;

const title = (response: { embed: { data: { title?: string } } }): string =>
  response.embed.data.title as string;

describe('GenericEmbedService description clamping', () => {
  it('passes a normal description straight through', () => {
    expect(desc(GenericEmbedService.buildNotFoundResponse('No scrobbles found.'))).toBe('No scrobbles found.');
  });

  it('leaves a description of exactly the limit untouched', () => {
    const atLimit = 'x'.repeat(4096);
    expect(desc(GenericEmbedService.buildNotFoundResponse(atLimit))).toBe(atLimit);
  });

  it('truncates one character over the limit rather than throwing', () => {
    const over = 'x'.repeat(4097);
    const out = desc(GenericEmbedService.buildNotFoundResponse(over));
    expect(out).toHaveLength(4096);
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncates a wildly over-long description instead of rendering it', () => {
    const huge = 'y'.repeat(20000);
    const out = desc(GenericEmbedService.buildNotFoundResponse(huge));
    expect(out).toHaveLength(4096);
  });

  it('keeps the START of a long description, not the end', () => {
    const out = desc(GenericEmbedService.buildNotFoundResponse(`${'a'.repeat(5000)}THE-END`));
    expect(out).not.toContain('THE-END');
    expect(out.startsWith('aaaa')).toBe(true);
  });

  it('substitutes a single space for an empty description', () => {
    // Zero length asserts just as hard as 4097 does, so `''` is not a safe
    // clamp either.
    expect(desc(GenericEmbedService.buildNotFoundResponse(''))).toBe(' ');
  });
});

describe('GenericEmbedService response shapes', () => {
  it('marks a not-found as NotFound so the caller can react to it', () => {
    expect(GenericEmbedService.buildNotFoundResponse('nothing').commandResponse).toBe(CommandResponse.NotFound);
  });

  it('marks wrong-input separately from not-found', () => {
    // The two render identically but mean different things: one is a bad
    // argument, the other is a real absence. Collapsing them makes a typo look
    // like "this user has never played anything".
    expect(GenericEmbedService.buildWrongInputResponse('bad query').commandResponse).toBe(CommandResponse.WrongInput);
    expect(GenericEmbedService.buildWrongInputResponse('bad query').commandResponse)
      .not.toBe(GenericEmbedService.buildNotFoundResponse('gone').commandResponse);
  });

  it('colours an error red', () => {
    const response = GenericEmbedService.buildCommandErrorResponse(CommandResponse.Error, 'boom');
    expect(response.embed.data.color).toBe(DiscordConstants.ErrorColorRed);
  });

  it('marks a success as Ok and honours the accent colour', () => {
    const response = GenericEmbedService.buildSuccessResponse('done', 0x00ff00);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.embed.data.color).toBe(0x00ff00);
  });

  it('leaves the accent unset when none is given', () => {
    // ResponseModel only sets a colour for a non-null argument, so an unset
    // colour falls back to Discord's default rather than to black.
    expect(GenericEmbedService.buildSuccessResponse('done').embed.data.color).toBeUndefined();
  });

  it('marks an info response as Ok too', () => {
    expect(GenericEmbedService.buildInfoResponse('note').commandResponse).toBe(CommandResponse.Ok);
  });

  it('gives a custom embed the Last.fm blue by default', () => {
    const response = GenericEmbedService.buildCustomEmbedResponse('A', 'B');
    expect(response.embed.data.color).toBe(DiscordConstants.LastFmColorBlue);
  });
});

describe('GenericEmbedService title clamping', () => {
  it('passes a normal title straight through', () => {
    expect(title(GenericEmbedService.buildCustomEmbedResponse('Top Artists', 'body'))).toBe('Top Artists');
  });

  it('truncates a title at 256 rather than throwing', () => {
    const out = title(GenericEmbedService.buildCustomEmbedResponse('z'.repeat(400), 'body'));
    expect(out).toHaveLength(256);
    expect(out.endsWith('…')).toBe(true);
  });

  it('substitutes a single space for an empty title', () => {
    expect(title(GenericEmbedService.buildCustomEmbedResponse('', 'body'))).toBe(' ');
  });

  it('clamps the description of a custom embed as well as the title', () => {
    const out = desc(GenericEmbedService.buildCustomEmbedResponse('A', 'b'.repeat(9000)));
    expect(out).toHaveLength(4096);
  });

  it('marks a custom embed as Ok', () => {
    expect(GenericEmbedService.buildCustomEmbedResponse('A', 'B').commandResponse).toBe(CommandResponse.Ok);
  });
});
