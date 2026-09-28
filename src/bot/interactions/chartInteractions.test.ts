import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MessageFlags,
  ModalBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ChartInteractions } from './chartInteractions';
import { ChartService, NotEnoughAlbumsError, TooManyImagesError } from '@bot/services/chartService';
import { ChartBuilders } from '@bot/builders/chartBuilders';
import { ChartSettings, TitleSetting } from '@bot/models/chartModels';
import { UserType, DataSource, type User } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { ChartResult } from '@bot/services/chartService';

const MODAL_PREFIX = 'chart-edit-modal:';

const ALBUM_CHART_ID = 'chart-edit:creator1:a:3x3:weekly:1:0:0:0:0:0:0:lfmuser';
const ARTIST_CHART_ID = 'chart-edit:creator1:r:3x3:weekly:0:0:0:0:0:0:0:lfmuser';
const ALBUM_MODAL_ID = `${MODAL_PREFIX}creator1:a:lfmuser`;
const ARTIST_MODAL_ID = `${MODAL_PREFIX}creator1:r:lfmuser`;

const makeUser = (): User => ({
  userId: 1,
  userNameLastFm: 'lfmuser',
  discordUserId: 'creator1',
  registeredOn: new Date('2025-01-01'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  totalPlayCount: 1234,
});

type ModalJson = {
  custom_id: string;
  title: string;
  components: Array<{
    label?: string;
    component: {
      custom_id?: string;
      value?: string;
      options?: Array<{ label: string; value: string; default?: boolean }>;
    };
  }>;
};

const modalJson = (mock: ReturnType<typeof vi.fn>): ModalJson => {
  const modal = mock.mock.calls[0]![0] as ModalBuilder;
  return modal.toJSON() as unknown as ModalJson;
};

const componentByLabel = (json: ModalJson, label: string) =>
  json.components.find((c) => c.label === label)?.component;

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'creator1' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
  };

const mkModal = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'creator1', username: 'Tester' },
    member: { displayName: 'CoolName' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    fields: {
      getTextInputValue: vi.fn((id: string) => (id === 'size' ? '3x3' : '')),
      getStringSelectValues: vi.fn((id: string) => {
        if (id === 'time_period') return ['weekly'];
        if (id === 'font') return ['default'];
        return [];
      }),
      getCheckboxGroup: vi.fn(() => []),
    },
    ...over,
  }) as unknown as ModalSubmitInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
    fields: {
      getTextInputValue: ReturnType<typeof vi.fn>;
      getStringSelectValues: ReturnType<typeof vi.fn>;
      getCheckboxGroup: ReturnType<typeof vi.fn>;
    };
  };

const build = (over: Record<string, unknown> = {}) => {
  const chartService = {
    generateAlbumChart: vi.fn(
      async (
        _discordUserId: string,
        _userNameLastFm: string,
        _settings: ChartSettings,
        _font?: string,
      ): Promise<ChartResult> => ({
        imageUrl: 'https://cdn/chart.png',
        albumsUsed: [{ name: 'Album A', artistName: 'Artist A', playcount: 10 }],
      }),
    ),
    generateArtistChart: vi.fn(
      async (
        _discordUserId: string,
        _userNameLastFm: string,
        _settings: ChartSettings,
        _font?: string,
      ): Promise<ChartResult> => ({
        imageUrl: 'https://cdn/chart.png',
        artistsUsed: [{ name: 'Artist A', playcount: 10 }],
      }),
    ),
    getDimensions: (settings: ChartSettings, option?: string | null) =>
      ChartService.getDimensions(settings, option),
    ...(over.chartService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    enqueueUserUpdate: vi.fn(),
    ...(over.userService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const ci = new ChartInteractions(chartService as never, userService as never, colorService as never);
  return { ci, chartService, userService, colorService };
};

const modalFields = (over: Record<string, unknown>) => ({
  getTextInputValue: vi.fn((id: string) => (id === 'size' ? '3x3' : '')),
  getStringSelectValues: vi.fn((id: string) => {
    if (id === 'time_period') return ['weekly'];
    if (id === 'font') return ['default'];
    return [];
  }),
  getCheckboxGroup: vi.fn(() => []),
  ...over,
});

const settingsFrom = (
  mock: ReturnType<typeof vi.fn>,
): ChartSettings => mock.mock.calls[0]![2] as ChartSettings;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChartInteractions.handleEditButton', () => {
  it('shows an edit modal for a valid album chart button', async () => {
    const { ci } = build();
    const press = mkButton(ALBUM_CHART_ID);

    await ci.handleEditButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
    const json = modalJson(press.showModal);
    expect(json.custom_id).toBe(ALBUM_MODAL_ID);
    expect(json.title).toBe('Edit chart settings');
  });

  it('shows an edit modal for an artist chart button', async () => {
    const { ci } = build();
    const press = mkButton(ARTIST_CHART_ID);

    await ci.handleEditButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
    expect(modalJson(press.showModal).custom_id).toBe(ARTIST_MODAL_ID);
  });

  it('returns early when the customId has fewer than 4 parts', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit:creator1');

    await ci.handleEditButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('returns early when the creatorId is empty', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit::a:3x3:weekly');

    await ci.handleEditButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('returns early when the period token is missing', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit:creator1:a:3x3');

    await ci.handleEditButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('rejects a non-creator with an ephemeral reply', async () => {
    const { ci } = build();
    const press = mkButton(ALBUM_CHART_ID, { user: { id: 'intruder' } });

    await ci.handleEditButton(press);

    expect(press.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Only the chart creator can edit this chart.' }),
    );
    expect(press.showModal).not.toHaveBeenCalled();
  });

  it('checkbox defaults reflect the flags in the customId', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit:creator1:a:3x3:weekly:1:1:0:1:1:0:0:lfmuser');

    await ci.handleEditButton(press);

    const options = componentByLabel(modalJson(press.showModal), 'Options')?.options ?? [];
    const defaultValue = (value: string) => options.find((o) => o.value === value)?.default;
    expect(defaultValue('titles')).toBe(true);
    expect(defaultValue('skip')).toBe(true);
    expect(defaultValue('rainbow')).toBe(true);
    expect(defaultValue('hidesingles')).toBe(true);
    expect(defaultValue('sfw')).toBe(false);
  });

  it('checkbox defaults are false when the flags are 0', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit:creator1:a:3x3:weekly:0:0:0:0:0:0:0:lfmuser');

    await ci.handleEditButton(press);

    const options = componentByLabel(modalJson(press.showModal), 'Options')?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.default).toBe(false);
    }
  });

  it('includes the release filter input for album charts only', async () => {
    const { ci } = build();
    const albumPress = mkButton(ALBUM_CHART_ID);
    const artistPress = mkButton(ARTIST_CHART_ID);

    await ci.handleEditButton(albumPress);
    await ci.handleEditButton(artistPress);

    const releaseLabel = 'Release filter (e.g. 2024 or 1990s)';
    expect(modalJson(albumPress.showModal).components.some((c) => c.label === releaseLabel)).toBe(true);
    expect(modalJson(artistPress.showModal).components.some((c) => c.label === releaseLabel)).toBe(false);
  });

  it('defaults an unknown period token to weekly', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit:creator1:a:3x3:bogus:0:0:0:0:0:0:0:lfmuser');

    await ci.handleEditButton(press);

    const select = componentByLabel(modalJson(press.showModal), 'Time period');
    expect(select?.options?.find((o) => o.default)?.value).toBe('weekly');
  });

  it('prefills the size input from the customId', async () => {
    const { ci } = build();
    const press = mkButton('chart-edit:creator1:a:4x2:weekly:0:0:0:0:0:0:0:lfmuser');

    await ci.handleEditButton(press);

    expect(componentByLabel(modalJson(press.showModal), 'Size (e.g. 3x3)')?.value).toBe('4x2');
  });
});

describe('ChartInteractions.handleEditModal', () => {
  it('rejects a non-creator with an ephemeral reply', async () => {
    const { ci } = build();
    const modal = mkModal(ALBUM_MODAL_ID, { user: { id: 'intruder', username: 'Intruder' } });

    await ci.handleEditModal(modal);

    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Only the chart creator can edit this chart.' }),
    );
    expect(modal.deferUpdate).not.toHaveBeenCalled();
    expect(modal.editReply).not.toHaveBeenCalled();
  });

  it('defers, generates an album chart, and edits with a Components V2 payload', async () => {
    const { ci, chartService, userService } = build();
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(modal.deferUpdate).toHaveBeenCalledTimes(1);
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('creator1');
    expect(chartService.generateAlbumChart).toHaveBeenCalledWith(
      'creator1',
      'lfmuser',
      expect.any(ChartSettings),
      'default',
    );
    expect(chartService.generateArtistChart).not.toHaveBeenCalled();
    expect(modal.editReply).toHaveBeenCalledTimes(1);
    const payload = modal.editReply.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.components).toEqual([expect.anything()]);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('generates an artist chart when the chartType is r', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ARTIST_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(chartService.generateArtistChart).toHaveBeenCalledTimes(1);
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
  });

  it('returns early when the user is no longer registered', async () => {
    const { ci, chartService, userService } = build({
      userService: { getUserByDiscordId: vi.fn(async () => null) },
    });
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('creator1');
    expect(chartService.generateAlbumChart).not.toHaveBeenCalled();
    expect(modal.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Your account is no longer registered.' }),
    );
  });

  it('applies a valid decade release filter', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'release_filter' ? '1990s' : id === 'size' ? '3x3' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.releaseDecadeFilter).toBe(1990);
    expect(settings.releaseYearFilter).toBeUndefined();
  });

  it('applies a valid year release filter', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'release_filter' ? '2024' : id === 'size' ? '3x3' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.releaseYearFilter).toBe(2024);
    expect(settings.releaseDecadeFilter).toBeUndefined();
  });

  it('ignores an invalid release filter', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'release_filter' ? 'abc' : id === 'size' ? '3x3' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.releaseYearFilter).toBeUndefined();
    expect(settings.releaseDecadeFilter).toBeUndefined();
  });

  it('ignores a decade below 1900', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'release_filter' ? '1890s' : id === 'size' ? '3x3' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    expect(settingsFrom(chartService.generateAlbumChart).releaseDecadeFilter).toBeUndefined();
  });

  it('ignores a year outside 1900-2100', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'release_filter' ? '2150' : id === 'size' ? '3x3' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    expect(settingsFrom(chartService.generateAlbumChart).releaseYearFilter).toBeUndefined();
  });

  it('does not read the release filter for artist charts', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ARTIST_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'release_filter' ? '1990s' : id === 'size' ? '3x3' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateArtistChart);
    expect(settings.releaseDecadeFilter).toBeUndefined();
    expect(settings.releaseYearFilter).toBeUndefined();
  });

  it('enables custom options for a non-default font', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getStringSelectValues: vi.fn((id: string) => {
          if (id === 'time_period') return ['weekly'];
          if (id === 'font') return ['Arial'];
          return [];
        }),
      }),
    });

    await ci.handleEditModal(modal);

    expect(settingsFrom(chartService.generateAlbumChart).customOptionsEnabled).toBe(true);
  });

  it('does not enable custom options for the default font', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(settingsFrom(chartService.generateAlbumChart).customOptionsEnabled).toBe(false);
  });

  it('maps checkbox options onto the chart settings', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getCheckboxGroup: vi.fn(() => ['titles', 'skip', 'rainbow', 'hidesingles']),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.titleSetting).toBe(TitleSetting.Titles);
    expect(settings.skipWithoutImage).toBe(true);
    expect(settings.rainbowSortingEnabled).toBe(true);
    expect(settings.filterSingles).toBe(true);
  });

  it('sets skipWithoutImage when only rainbow is checked', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getCheckboxGroup: vi.fn(() => ['rainbow']),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.skipWithoutImage).toBe(true);
    expect(settings.rainbowSortingEnabled).toBe(true);
    expect(settings.filterSingles).toBe(false);
    expect(settings.titleSetting).toBe(TitleSetting.TitlesDisabled);
  });

  it('uses the member displayName for the response', async () => {
    const { ci } = build();
    const spy = vi.spyOn(ChartBuilders, 'buildAlbumChartResponse').mockReturnValue({
      isComponentsV2: true,
      componentsV2Container: { id: 'container' },
      hasFile: () => false,
    } as never);
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      'CoolName',
      expect.anything(),
      expect.anything(),
      0xff0000,
    );
  });

  it('falls back to the username when the member has no displayName', async () => {
    const { ci } = build();
    const spy = vi.spyOn(ChartBuilders, 'buildAlbumChartResponse').mockReturnValue({
      isComponentsV2: true,
      componentsV2Container: { id: 'container' },
      hasFile: () => false,
    } as never);
    const modal = mkModal(ALBUM_MODAL_ID, { member: {} });

    await ci.handleEditModal(modal);

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      'Tester',
      expect.anything(),
      expect.anything(),
      0xff0000,
    );
  });

  it('enqueues a user update after generating the chart', async () => {
    const { ci, userService } = build();
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(userService.enqueueUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1 }),
      'Command',
    );
  });

  it('includes the file when the chart result has a buffer', async () => {
    const { ci } = build({
      chartService: {
        generateAlbumChart: vi.fn(async (): Promise<ChartResult> => ({
          buffer: Buffer.from('png-bytes'),
          albumsUsed: [{ name: 'Album A', artistName: 'Artist A', playcount: 10 }],
        })),
      },
    });
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    const payload = modal.editReply.mock.calls[0]![0] as { files?: Array<{ name?: string }> };
    expect(payload.files).toHaveLength(1);
    expect(payload.files![0]!.name).toBe('chart.png');
  });

  it('reports NotEnoughAlbumsError with the builder description', async () => {
    const { ci } = build({
      chartService: {
        generateAlbumChart: vi.fn(async () => {
          throw new NotEnoughAlbumsError(5, 9);
        }),
      },
    });
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(modal.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('You have listened to **5** albums') }),
    );
  });

  it('reports TooManyImagesError with the size limit message', async () => {
    const { ci } = build({
      chartService: {
        generateAlbumChart: vi.fn(async () => {
          throw new TooManyImagesError();
        }),
      },
    });
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(modal.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Charts are limited to 100 total images (`10x10`).' }),
    );
  });

  it('reports a generic failure message for unexpected errors', async () => {
    const { ci } = build({
      chartService: {
        generateAlbumChart: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    expect(modal.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Something went wrong while regenerating the chart.' }),
    );
  });

  it('uses the legacy embed payload when the response is not Components V2', async () => {
    vi.spyOn(ChartBuilders, 'buildAlbumChartResponse').mockReturnValue({
      isComponentsV2: false,
      buildEmbed: () => ['embed'],
      buildComponents: () => ['row'],
      hasFile: () => false,
    } as never);
    const { ci } = build();
    const modal = mkModal(ALBUM_MODAL_ID);

    await ci.handleEditModal(modal);

    const payload = modal.editReply.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.embeds).toEqual(['embed']);
    expect(payload.components).toEqual(['row']);
    expect(payload.flags).toBeUndefined();
  });

  it('defaults the size to 3x3 when the size field is empty', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({ getTextInputValue: vi.fn(() => '') }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.width).toBe(3);
    expect(settings.height).toBe(3);
  });

  it('applies a custom size from the size field', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getTextInputValue: vi.fn((id: string) => (id === 'size' ? '4x2' : '')),
      }),
    });

    await ci.handleEditModal(modal);

    const settings = settingsFrom(chartService.generateAlbumChart);
    expect(settings.width).toBe(4);
    expect(settings.height).toBe(2);
  });

  it('defaults the period to weekly when the select value is missing', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getStringSelectValues: vi.fn((id: string) => (id === 'font' ? ['default'] : [])),
      }),
    });

    await ci.handleEditModal(modal);

    expect(settingsFrom(chartService.generateAlbumChart).timespanString).toBe('Weekly');
  });

  it('passes the selected period through to the chart settings', async () => {
    const { ci, chartService } = build();
    const modal = mkModal(ALBUM_MODAL_ID, {
      fields: modalFields({
        getStringSelectValues: vi.fn((id: string) => {
          if (id === 'time_period') return ['monthly'];
          if (id === 'font') return ['default'];
          return [];
        }),
      }),
    });

    await ci.handleEditModal(modal);

    expect(settingsFrom(chartService.generateAlbumChart).timespanString).toBe('Monthly');
  });
});
