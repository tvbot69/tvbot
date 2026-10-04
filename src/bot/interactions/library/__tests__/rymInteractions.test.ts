import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RymInteractions } from '@bot/interactions/library/rymInteractions';
import { RymTransport } from '@rateyourmusic/api/rymTransport';
import { MessageFlags } from 'discord.js';

const fixture = (name: string): string =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'rateyourmusic', 'api', 'fixtures', name),
    'utf8',
  );

const build = (html: string) => {
  const transport = new RymTransport({ solverUrl: 'http://localhost:8191', minDelayMs: 0 });
  vi.spyOn(transport, 'getHtml').mockImplementation(async () => ({
    html,
    status: 200,
    userAgent: 'UA',
    url: 'https://rateyourmusic.com/x',
  }));
  const colorService = { getAccentColorAsync: vi.fn(async () => 0x445566) };
  const artworkService = { getArtistImageUrl: vi.fn(async () => 'https://img/artist.jpg') };
  const interactions = new RymInteractions(
    transport as never,
    colorService as never,
    artworkService as never,
  );
  return { interactions, colorService, artworkService };
};

type UpdatePayload = {
  components: Array<{ toJSON: () => unknown }>;
  flags: number;
};

const buttonInteraction = (customId: string) => {
  const update = vi.fn(async (_payload: UpdatePayload) => undefined);
  const deferUpdate = vi.fn(async () => undefined);
  const showModal = vi.fn(async (_modal: unknown) => undefined);
  const interaction = {
    update,
    deferUpdate,
    showModal,
    guildId: 'g-1',
    customId,
    isButton: () => true,
  };
  return interaction as unknown as Parameters<RymInteractions['handleButton']>[0] & {
    update: typeof update;
    deferUpdate: typeof deferUpdate;
    showModal: typeof showModal;
  };
};

describe('RymInteractions pagination', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('next on an artist card re-renders with the next discography page', async () => {
    const { interactions } = build(fixture('artist_radiohead.html'));
    const interaction = buttonInteraction('rymartist:next:0:radiohead');
    await interactions.handleButton(interaction);
    expect(interaction.update).toHaveBeenCalledTimes(1);
    const payload = interaction.update.mock.calls[0]![0];
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    const json = JSON.stringify(payload.components[0]!.toJSON());
    // page 2 of the discography starts at the eleventh row, not the first
    expect(json).toContain('Glastonbury Festival 1994');
    expect(json).not.toContain('Pablo Honey');
  });

  it('next on a chart card renders the second page of entries', async () => {
    const { interactions } = build(fixture('charts_all_time.html'));
    const interaction = buttonInteraction('rymchart:next:0:2025');
    await interactions.handleButton(interaction);
    expect(interaction.update).toHaveBeenCalledTimes(1);
  });

  it('jump opens a modal instead of updating the card', async () => {
    const { interactions } = build(fixture('artist_radiohead.html'));
    const interaction = buttonInteraction('rymartist:jump:0:radiohead');
    await interactions.handleButton(interaction);
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('an unknown prefix leaves the card alone', async () => {
    const { interactions } = build(fixture('artist_radiohead.html'));
    const interaction = buttonInteraction('something-else:next:0:x');
    await interactions.handleButton(interaction);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
  });
});