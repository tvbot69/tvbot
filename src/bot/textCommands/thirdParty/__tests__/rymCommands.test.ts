import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RymCommands, artistSlugFromInput, releaseSlugFromInput } from '@bot/textCommands/thirdParty/rymCommands';
import { RymOriginBlockError } from '@rateyourmusic/api/rymClient';
import { RymTransport } from '@rateyourmusic/api/rymTransport';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const solverHtml = (html: string, status = 200) =>
  JSON.stringify({
    status: 'ok',
    solution: { url: 'https://rateyourmusic.com/x', status, response: html, userAgent: 'UA' },
  });

const build = (html: string, status = 200) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (body.cmd === 'sessions.create') {
      return new Response(JSON.stringify({ status: 'ok', session: 's1' }));
    }
    return new Response(solverHtml(html, status));
  });
  const prefixService = { getPrefix: vi.fn(async () => '.') };
  const transport = new RymTransport({ solverUrl: 'http://localhost:8191', minDelayMs: 0 });
  const commands = new RymCommands(transport as never, prefixService as never);
  return { commands, transport };
};

const CHART_HTML = `
<div class="page_charts_section_charts_item">
  <a class="page_charts_section_charts_item_link release" href="/release/album/radiohead/ok-computer/">OK Computer</a>
  <span class="page_charts_section_charts_item_credited_text">Radiohead</span>
  <div class="page_charts_section_charts_item_title_date_compact"><span>16 June 1997</span></div>
  <a class="artist" href="/artist/radiohead">Radiohead</a>
  <div class="page_charts_section_charts_item_genres_primary"><a class="genre">Art Rock</a></div>
  <div class="page_charts_section_charts_item_details_average_num">4.10</div>
  <div class="page_charts_section_charts_item_details_ratings"><span class="abbr">120k</span></div>
</div>`;

describe('rym slug parsing', () => {
  it('accepts a bare slug', () => {
    expect(artistSlugFromInput('radiohead')).toBe('radiohead');
  });

  it('extracts from a full URL', () => {
    expect(artistSlugFromInput('https://rateyourmusic.com/artist/radiohead')).toBe('radiohead');
  });

  it('extracts from an /artist/ path', () => {
    expect(artistSlugFromInput('/artist/radiohead')).toBe('radiohead');
  });

  it('parses a release slug and type from a URL', () => {
    expect(releaseSlugFromInput('https://rateyourmusic.com/release/album/pixies/surfer-rosa/')).toEqual({
      slug: 'pixies/surfer-rosa',
      releaseType: 'album',
    });
  });

  it('passes a bare slug through', () => {
    expect(releaseSlugFromInput('pixies/surfer-rosa')).toEqual({ slug: 'pixies/surfer-rosa' });
  });
});

describe('RymCommands', () => {
  it('.rym chart returns a ComponentsV2 chart response', async () => {
    const { commands } = build(CHART_HTML);
    const res = await commands.rymAsync(ctx(), ['chart', 'all-time']);
    expect(res.commandResponse).toBe(CommandResponse.Ok);
    expect(res.isComponentsV2).toBe(true);
    vi.restoreAllMocks();
  });

  it('unknown subcommand returns NotFound', async () => {
    const { commands } = build(CHART_HTML);
    const res = await commands.rymAsync(ctx(), ['bogus']);
    expect(res.commandResponse).toBe(CommandResponse.NotFound);
    vi.restoreAllMocks();
  });

  it('origin-block error surfaces honestly', async () => {
    const transport = new RymTransport({ solverUrl: 'http://localhost:8191', minDelayMs: 0 });
    vi.spyOn(transport, 'getHtml').mockRejectedValue(new RymOriginBlockError('https://rateyourmusic.com/x'));
    const prefixService = { getPrefix: vi.fn(async () => '.') };
    const commands = new RymCommands(transport as never, prefixService as never);
    const res = await commands.rymAsync(ctx(), ['artist', 'radiohead']);
    expect(res.commandResponse).toBe(CommandResponse.Error);
    expect(res.embed.data.description).toContain('origin-blocked');
    vi.restoreAllMocks();
  });
});
