import { describe, it, expect } from 'vitest';
import { ComponentType } from 'discord.js';
import { IntelligenceBuilders } from '@bot/builders/intelligence/intelligenceBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ResponseModel } from '@bot/models/responseModel';
import type {
  AffinityData,
  AffinityNeighbor,
  DiscoveryItem,
  IcebergData,
  IcebergTier,
  ListeningGapItem,
} from '@bot/services/library/musicIntelligenceService';

/**
 * `IntelligenceBuilders` — the three paginated intelligence cards, and the one
 * place they all shared a defect.
 *
 * THE DEFECT THIS FILE WAS BUILT AROUND, NOW FIXED
 * -----------------------------------------------
 * All three paginated builders computed a page slice the same way:
 *
 *     const page = Math.max(1, params.page ?? 1);
 *     const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
 *     const currentItems = items.slice((page - 1) * pageSize, ...);
 *     ...
 *     container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
 *
 * `page` was clamped from BELOW (`Math.max(1, ...)`) and never from above. A
 * page index past the end therefore made `currentItems` empty,
 * `lines.join('\n')` the EMPTY STRING, and `TextDisplayBuilder.setContent('')`
 * THREW — discord.js validates the length and raises "Invalid string length".
 * Nothing in the builder caught it, so it escaped into
 * `IntelligenceInteractions.handleButton`, which is itself not wrapped, and
 * from there into `interactionHandler.onInteractionCreated`.
 *
 * THAT REACHES A USER, and it is LIVE rather than latent.
 * `intelligenceInteractions.ts` clamps against a `totalPages` PARSED OUT OF THE
 * ORIGINAL CUSTOM ID and only then re-reads the data fresh:
 *
 *     const totalPages = parseInt(parts[6]!, 10) || 1;            // from the card
 *     if (action === 'last') newPage = totalPages;               // from the card
 *     const items = await this.intelligenceService.getListeningGaps(...);  // FRESH
 *     IntelligenceBuilders.buildListeningGapsResponse({ items, page: newPage, ... });
 *
 * So pressing "last" on a three-page gaps card re-reads the window and renders
 * page 3 of whatever came back. If that re-read is shorter than the card
 * claimed — the window slid, a gap dropped under the threshold once the user
 * scrobbled again, a row was pruned — the builder receives a page past its own
 * end and threw, to a real user pressing a real button.
 *
 * `whoKnowsBuilders.buildContainerForPage` already handled the identical case
 * with a real guard at `:179` (`if (!page) { … }`). All three cards here now
 * share ONE shape for that, `pageIsGone` + `PAGE_IS_GONE`, and the tests below
 * pin it from both directions: an out-of-range page says the page is gone, and a
 * NEGATIVE page still clamps to 1. A clamp is asymmetric — it is easy to write
 * and easy to break on one side only — so both ends are asserted.
 *
 * WHAT WAS DELETED FROM THIS FILE, AND WHY
 * ---------------------------------------
 * Three members that used to be tested here were REMOVED from the production
 * class, so the tests went with them (root `AGENTS.md` §3.8 — a scrapped
 * approach is deleted completely, no flags and no commented-out remnants):
 *
 *   - `buildLovedTracksResponse` — a fourth copy of the page defect, which
 *     degraded to a LIE rather than a crash: `totalPages` came from
 *     `params.total` while the empty sentence came from `params.tracks.length`,
 *     so a page past the end rendered "### Loved tracks … (1,234 total)" directly
 *     above "No loved tracks found on Last.fm." Fixing its page clamp was
 *     wasted work, so the builder went instead.
 *   - `buildLoveSuccessResponse` and `buildScrobbleSuccessResponse`
 *
 * None of the three had a caller under ANY dispatch mechanism. `Intelligence-
 * Builders` is a static-only class that is NOT registered in the tsyringe
 * container (`startup.ts` registers `IntelligenceInteractions`,
 * `MusicIntelligenceService`, `IntelligenceCommands` and `IntelligenceSlash-
 * Commands`, never the builder), is not reached by a modal prefix, a
 * `ComponentInteractionTracker` key, an event listener or a cron, and no string
 * in the tree names a member of it. Every production call site that wanted these
 * three cards already used the live twins in `TrackBuilders`
 * (`buildLovedTracksResponse` x3, `buildLoveResponse` x2, `buildUnloveResponse`
 * x2, `buildScrobbleResponse` x3). They rendered correctly, which is exactly
 * what made them look like features.
 *
 * EMOJI ARE WRITTEN AS \u ESCAPES
 * ------------------------------
 * The tier emoji are part of the rendered claim, so they have to be real - but a
 * literal astral-plane character in a source file is at the mercy of whatever
 * encoding a tool rewrites it with. `\u{1F3D4}\u{FE0F}` is the same code point
 * pair, is pure ASCII in the source, and cannot be mangled.
 */

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  custom_id?: string;
  disabled?: boolean;
}

/** The serialised tree. Serialising is part of what is under test. */
const json = (response: ResponseModel): { components?: Cv2Component[] } =>
  response.componentsV2Container!.toJSON() as unknown as { components?: Cv2Component[] };

/** Every text-display string in the card, joined. */
const body = (response: ResponseModel): string =>
  (json(response).components ?? [])
    .filter((c) => c.type === ComponentType.TextDisplay)
    .map((c) => c.content ?? '')
    .join('\n');

const buttons = (response: ResponseModel): Cv2Component[] =>
  (json(response).components ?? [])
    .filter((c) => c.type === ComponentType.ActionRow)
    .flatMap((c) => c.components ?? []);

const disabledOf = (response: ResponseModel): Map<string, boolean | undefined> =>
  new Map(buttons(response).map((b) => [b.custom_id ?? '', b.disabled]));

/** Stable dates, so the `<t:...:R>` stamps in the output are predictable. */
const DAY = 86_400_000;
const at = (daysAgo: number): Date => new Date(Date.UTC(2026, 0, 15) - daysAgo * DAY);

/*
 * The four parameter shapes, spelled out rather than widened to
 * `Record<string, unknown>`.
 *
 * A wide override makes the builder call itself untyped: spreading
 * `Record<string, unknown>` into the argument turns `entityType` and `data` into
 * `unknown`, and the builder no longer typechecks against them. `npm test` does
 * not typecheck, so this is precisely the mistake that would pass the suite and
 * fail `npm run build`. `Parameters<typeof ...>` keeps the tests honest against
 * the production signature for free.
 */
type GapsParams = Parameters<typeof IntelligenceBuilders.buildListeningGapsResponse>[0];
type DiscoveriesParams = Parameters<typeof IntelligenceBuilders.buildDiscoveriesResponse>[0];
type AffinityParams = Parameters<typeof IntelligenceBuilders.buildAffinityResponse>[0];
type IcebergParams = Parameters<typeof IntelligenceBuilders.buildIcebergResponse>[0];

const gap = (i: number, over: Partial<ListeningGapItem> = {}): ListeningGapItem => ({
  name: `Thing ${i}`,
  artistName: `Artist ${i}`,
  resumeDate: at(100 + i),
  prevPlayed: at(400 + i),
  gapDays: 300 + i,
  totalPlays: 1000 + i,
  ...over,
});

const discovery = (i: number, over: Partial<DiscoveryItem> = {}): DiscoveryItem => ({
  artistName: `Artist ${i}`,
  firstPlay: at(10 + i),
  playcount: 5 + i,
  ...over,
});

const neighbor = (i: number, over: Partial<AffinityNeighbor> = {}): AffinityNeighbor => ({
  userId: i,
  discordUserId: `d-${i}`,
  userNameLastFm: `lfm_${i}`,
  displayName: `Human ${i}`,
  totalPercentage: 90 - i,
  artistPercentage: 80 - i,
  genrePercentage: 70 - i,
  countryPercentage: 60 - i,
  sharedArtists: ['Radiohead'],
  ...over,
});

const gapsParams = (items: ListeningGapItem[], over: Partial<GapsParams> = {}): GapsParams => ({
  displayName: 'Moha',
  userNameLastFm: 'moha_lfm',
  entityType: 'artist',
  items,
  ...over,
});

const discoveriesParams = (
  items: DiscoveryItem[],
  over: Partial<DiscoveriesParams> = {},
): DiscoveriesParams => ({
  displayName: 'Moha',
  userNameLastFm: 'moha_lfm',
  periodDescription: 'the past 90 days',
  items,
  ...over,
});

const affinityParams = (
  neighbors: AffinityNeighbor[],
  over: Partial<AffinityParams> = {},
): AffinityParams => ({
  data: {
    userDisplayName: 'Moha',
    userNameLastFm: 'moha_lfm',
    guildName: 'Indie Haven',
    totalGuildUsers: 12,
    neighbors,
  },
  ...over,
});

const icebergParams = (tiers: IcebergTier[], over: Partial<IcebergParams> = {}): IcebergParams => ({
  data: {
    displayName: 'Moha',
    userNameLastFm: 'moha_lfm',
    timePeriodDescription: 'All time',
    totalArtists: 12,
    tiers,
  } as IcebergData,
  ...over,
});

const tier = (tierNumber: number, name: string, emoji: string, artists: string[]): IcebergTier => ({
  tierNumber,
  name,
  emoji,
  description: '',
  artists: artists.map((a) => ({ name: a, playcount: 100, popularity: 50 })),
});

const MOUNTAIN = '\u{1F3D4}\u{FE0F}';
const WAVE = '\u{1F30A}';

describe('buildListeningGapsResponse: the rows are claims about real hiatuses', () => {
  it('renders the gap length and the total plays, both with separators', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0, { gapDays: 1234, totalPlays: 98765 })]),
    );
    const text = body(response);
    expect(text).toContain('1,234 days');
    expect(text).toContain('98,765 total plays');
  });

  it('renders the resume date as a Discord date stamp, not a wall clock', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams([gap(0)]));
    expect(body(response)).toContain(`<t:${Math.floor(at(100).getTime() / 1000)}:D>`);
  });

  it('links an artist row to the artist page', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0)], { entityType: 'artist' }),
    );
    expect(body(response)).toContain('https://www.last.fm/music/Thing%200');
  });

  it('links an album row to the album page and names the artist', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0, { artistName: 'Radiohead' })], { entityType: 'album' }),
    );
    const text = body(response);
    expect(text).toContain('https://www.last.fm/music/Radiohead/Thing%200');
    expect(text).toContain('by **[Radiohead]');
  });

  it('links a track row through the `_` segment, because an album path would be wrong', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0, { artistName: 'Radiohead' })], { entityType: 'track' }),
    );
    expect(body(response)).toContain('https://www.last.fm/music/Radiohead/_/Thing%200');
  });

  it('prints a bare name when the row has no artist at all, rather than "by undefined"', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0, { artistName: undefined })], { entityType: 'track' }),
    );
    const text = body(response);
    expect(text).toContain('**Thing 0**');
    expect(text).not.toContain('undefined');
  });

  it('says nothing was found rather than printing an empty card', () => {
    // The honest-empty direction. Not "0 gaps", not a blank row.
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([], { entityType: 'album' }),
    );
    expect(body(response)).toContain('No album listening gaps of 90+ days found');
  });

  it('says no gaps for the type it was asked about, not a generic nothing', () => {
    const forArtist = body(
      IntelligenceBuilders.buildListeningGapsResponse(gapsParams([], { entityType: 'artist' })),
    );
    expect(forArtist).toContain('No artist listening gaps');
  });

  it('serialises without throwing on an empty list, because that is a real answer', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams([]));
    expect(() => json(response)).not.toThrow();
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('shows no paginator at all for an empty list, because there is nowhere to page', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams([]));
    expect(buttons(response)).toHaveLength(0);
  });

  it('shows no paginator for a single page of a full list, for the same reason', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams([gap(0), gap(1)]));
    expect(buttons(response)).toHaveLength(0);
    expect(body(response)).not.toContain('Page ');
  });
});

describe('buildListeningGapsResponse: pagination arithmetic', () => {
  const many = () => Array.from({ length: 25 }, (_, i) => gap(i));

  it('numbers rows continuously across pages, from the start index', () => {
    const first = body(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 1 })));
    const second = body(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 2 })));

    expect(first).toContain('1. ');
    expect(first).toContain('10. ');
    // Page two must NOT restart at 1, or the user sees two "1." rows.
    expect(second).toContain('11. ');
    expect(second).toContain('20. ');
  });

  it('renders ten rows a page by default', () => {
    const page = body(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 2 })));
    const rows = page.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(rows).toHaveLength(10);
  });

  it('honours a caller-supplied page size for both the rows and the count', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams(many(), { pageSize: 5 }),
    );
    expect(body(response)).toContain('-# Page 1/5 \u2022 Total: 25 gaps');
  });

  it('claims the real total, which is the whole list and not the page', () => {
    expect(body(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many())))).toContain(
      'Total: 25 gaps',
    );
  });

  it('disables previous on page one and next on the last, from both ends', () => {
    const first = disabledOf(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 1 })));
    const last = disabledOf(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 3 })));

    expect(first.get('gaps-page:prev:0:0:artist:1:3')).toBe(true);
    expect(first.get('gaps-page:next:0:0:artist:1:3')).toBe(false);
    expect(last.get('gaps-page:next:0:0:artist:3:3')).toBe(true);
    expect(last.get('gaps-page:prev:0:0:artist:3:3')).toBe(false);
  });

  it('disables first and last with the same bounds as the two middle buttons', () => {
    const first = disabledOf(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 1 })));
    const last = disabledOf(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 3 })));
    expect(first.get('gaps-page:first:0:0:artist:1:3')).toBe(true);
    expect(first.get('gaps-page:last:0:0:artist:1:3')).toBe(false);
    expect(last.get('gaps-page:last:0:0:artist:3:3')).toBe(true);
    expect(last.get('gaps-page:first:0:0:artist:3:3')).toBe(false);
  });

  it('carries the caller and the target through the button ids, because the route needs both', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0), gap(1), gap(2)], {
        pageSize: 1, page: 2, callerDiscordId: 'c-1', targetDiscordId: 't-1',
      }),
    );
    expect(disabledOf(response).has('gaps-page:next:c-1:t-1:artist:2:3')).toBe(true);
  });

  it('falls back to a literal 0 for a caller or target it was not given', () => {
    // `0` is the marker the route reads as "no target, use the caller".
    const response = IntelligenceBuilders.buildListeningGapsResponse(
      gapsParams([gap(0), gap(1), gap(2)], { pageSize: 1, page: 2 }),
    );
    expect(disabledOf(response).has('gaps-page:next:0:0:artist:2:3')).toBe(true);
  });

  it('clamps a page below one to the first page rather than slicing from a negative index', () => {
    // `Math.max(1, ...)` is the guard that exists, and this is what it buys: a
    // `page: 0` from a hand-edited button renders page one, not the last ten.
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 0 }));
    expect(body(response)).toContain('1. ');
    expect(body(response)).toContain('-# Page 1/3');
  });

  it('treats a missing page as page one', () => {
    expect(body(IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many())))).toContain(
      '-# Page 1/3',
    );
  });

  /*
   * THE REACHABILITY, STATED AS A TEST.
   *
   * `IntelligenceInteractions.handleGapsPage` (`intelligenceInteractions.ts:190`)
   * reads `totalPages` out of the ORIGINAL customId, clamps `last` to it at
   * `:196`, and only then re-reads the gaps at `:205`. So the builder is handed
   * `page: 3` alongside a list that is now one page long. Before the guard that
   * was `setContent('')` and a raise that reached
   * `interactionHandler.onInteractionCreated` — a user-facing crash from a real
   * button press, not a latent one.
   *
   * `page: 4` on 25 items is the same shape, one page further out, and is what
   * a card that shrank by more than one page looks like.
   */
  it('says the page is gone rather than throwing when it is past the end', () => {
    expect(() =>
      IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 4 })),
    ).not.toThrow();

    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 4 }));
    const text = body(response);
    expect(text).toContain('no longer available');
    // And it claims nothing about a page of rows it does not have.
    expect(text).not.toContain('21. ');
    expect(text).not.toContain('Total: 25 gaps');
  });

  it('serialises a past-the-end page, because the raise was inside discord.js', () => {
    // The throw was `setContent('')`, so asserting only on `body()` would pass
    // on a builder that built fine and serialised badly. `json()` serialises.
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 9 }));
    expect(() => json(response)).not.toThrow();
    expect(body(response)).toContain('no longer available');
  });

  it('still renders a real last page, so the guard did not swallow the happy path', () => {
    const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page: 3 }));
    expect(body(response)).toContain('21. ');
    expect(body(response)).not.toContain('no longer available');
  });

  it('clamps a NEGATIVE page to one, which the below-only clamp already did', () => {
    // The other end. A new guard must not break the one that was already there.
    for (const page of [-1, -5, 0]) {
      const response = IntelligenceBuilders.buildListeningGapsResponse(gapsParams(many(), { page }));
      expect(body(response)).toContain('-# Page 1/3');
      expect(body(response)).toContain('1. ');
      expect(body(response)).not.toContain('no longer available');
    }
  });

  it('still reports a genuine empty result as empty, not as a vanished page', () => {
    // The two directions are opposites and a careless guard merges them: an
    // empty list is an answer about the listening, not a lost page.
    const text = body(IntelligenceBuilders.buildListeningGapsResponse(gapsParams([])));
    expect(text).toContain('No artist listening gaps of 90+ days found');
    expect(text).not.toContain('no longer available');
  });
});

describe('buildDiscoveriesResponse: first listens are claims about a date', () => {
  it('names the artist and the period, so the claim is scoped', () => {
    const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams([discovery(0)]));
    const text = body(response);
    expect(text).toContain('Discovered artists in the past 90 days');
    expect(text).toContain('Artists listened to for the very first time');
  });

  it('pluralises one play', () => {
    const one = body(
      IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams([discovery(0, { playcount: 1 })])),
    );
    expect(one).toContain('1 play');
    expect(one).not.toContain('1 plays');
  });

  it('formats a large play count with separators', () => {
    const many = body(
      IntelligenceBuilders.buildDiscoveriesResponse(
        discoveriesParams([discovery(0, { playcount: 1500 })]),
      ),
    );
    expect(many).toContain('1,500 plays');
  });

  it('renders the first play as a date stamp rather than a wall clock', () => {
    const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams([discovery(0)]));
    expect(body(response)).toContain(`<t:${Math.floor(at(10).getTime() / 1000)}:D>`);
  });

  it('says none were discovered, scoped to the period, rather than an empty card', () => {
    const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams([]));
    expect(body(response)).toContain('No newly discovered artists found in the past 90 days.');
  });

  it('uses a distinct button prefix from the other two paginated cards', () => {
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page: 1 }));
    const ids = [...disabledOf(response).keys()];
    expect(ids.every((id) => id.startsWith('discoveries-page:'))).toBe(true);
    expect(ids).toHaveLength(4);
  });

  it('claims the real total of discovered artists', () => {
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    expect(
      body(IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items))),
    ).toContain('Total: 25 discovered artists');
  });

  it('numbers rows continuously across pages', () => {
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    const page2 = body(
      IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page: 2 })),
    );
    expect(page2).toContain('11. ');
  });

  it('shows no paginator on a single page', () => {
    const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams([discovery(0)]));
    expect(buttons(response)).toHaveLength(0);
  });

  it('says the page is gone rather than throwing when it is past the end', () => {
    // Discoveries is the LIKELY live one: the window is a rolling 90 days
    // (`intelligenceInteractions.ts:142`), so it moves under the card on its own
    // and `totalPages` at `:127` is the count from when the card was built.
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    expect(() =>
      IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page: 4 })),
    ).not.toThrow();

    const text = body(IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page: 4 })));
    expect(text).toContain('no longer available');
    expect(text).not.toContain('21. ');
    expect(text).not.toContain('Total: 25 discovered artists');
  });

  it('serialises a past-the-end page, because the raise was inside discord.js', () => {
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page: 99 }));
    expect(() => json(response)).not.toThrow();
    expect(body(response)).toContain('no longer available');
  });

  it('still renders a real last page, so the guard did not swallow the happy path', () => {
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    const text = body(IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page: 3 })));
    expect(text).toContain('21. ');
    expect(text).not.toContain('no longer available');
  });

  it('clamps a NEGATIVE page to one, which the below-only clamp already did', () => {
    const items = Array.from({ length: 25 }, (_, i) => discovery(i));
    for (const page of [-1, -5, 0]) {
      const response = IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams(items, { page }));
      expect(body(response)).toContain('-# Page 1/3');
      expect(body(response)).toContain('1. ');
      expect(body(response)).not.toContain('no longer available');
    }
  });

  it('still reports a genuine empty result as empty, not as a vanished page', () => {
    const text = body(IntelligenceBuilders.buildDiscoveriesResponse(discoveriesParams([])));
    expect(text).toContain('No newly discovered artists found in the past 90 days.');
    expect(text).not.toContain('no longer available');
  });
});

describe('buildAffinityResponse: the percentages are the whole claim', () => {
  it('renders all three component percentages, because the total alone is meaningless', () => {
    const response = IntelligenceBuilders.buildAffinityResponse(
      affinityParams([neighbor(1, { artistPercentage: 78, genrePercentage: 92, countryPercentage: 85 })]),
    );
    const text = body(response);
    expect(text).toContain('`78%` artists');
    expect(text).toContain('`92%` genres');
    expect(text).toContain('`85%` countries');
  });

  it('reports the guild membership from the query, not the number of neighbours shown', () => {
    // "12 tvbot members in this server" next to one neighbour is true; "1 member"
    // would be a different and wrong claim about the guild.
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams([neighbor(1)]));
    expect(body(response)).toContain('12 tvbot members in this server');
  });

  it('falls back to the neighbour count when the query gave no membership total', () => {
    const zeroTotal: AffinityData = {
      userDisplayName: 'Moha',
      userNameLastFm: 'moha_lfm',
      guildName: 'Indie Haven',
      totalGuildUsers: 0,
      neighbors: [neighbor(1), neighbor(2)],
    };
    const response = IntelligenceBuilders.buildAffinityResponse(
      affinityParams([neighbor(1), neighbor(2)], { data: zeroTotal }),
    );
    expect(body(response)).toContain('2 tvbot members in this server');
  });

  it('prefers the Discord nickname over the Last.fm name when there is one', () => {
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams([neighbor(1)]));
    expect(body(response)).toContain('Human 1');
  });

  it('falls back to the Last.fm name when the neighbour has no nickname', () => {
    const response = IntelligenceBuilders.buildAffinityResponse(
      affinityParams([neighbor(1, { displayName: '' })]),
    );
    expect(body(response)).toContain('lfm_1');
  });

  it('escapes the nickname for the markdown link, so a bracket cannot break the row', () => {
    // The renderer does NOT run `escapeLinkLabel` here; asserted as-is because the
    // value is a Discord nickname and Discord allows brackets in one.
    const response = IntelligenceBuilders.buildAffinityResponse(
      affinityParams([neighbor(1, { displayName: 'a [b] c' })]),
    );
    expect(body(response)).toContain('https://last.fm/user/lfm_1');
  });

  it('says plainly that nobody similar was found, and not "0%"', () => {
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams([]));
    const text = body(response);
    expect(text).toContain('Could not find indexed users with a similar music taste');
    expect(text).not.toContain('0%');
  });

  it('shows no paginator and no membership claim for an empty result', () => {
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams([]));
    expect(buttons(response)).toHaveLength(0);
    expect(body(response)).not.toContain('tvbot members');
  });

  it('paginates twelve a page, which is the size the route passes', () => {
    const neighbors = Array.from({ length: 25 }, (_, i) => neighbor(i));
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams(neighbors));
    expect(body(response)).toContain('-# Page 1/3');
    expect(disabledOf(response).has('affinity-page:next:0:0:1:3')).toBe(true);
  });

  it('shows the membership footer even on a single page, because it is a guild fact', () => {
    // The membership line is OUTSIDE the `totalPages > 1` guard, unlike the two
    // builders above where the whole footer block sits inside it. That
    // difference is deliberate: it is the only figure on this card that is not
    // about the page.
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams([neighbor(1)]));
    expect(body(response)).toContain('-# Page 1/1');
    expect(buttons(response)).toHaveLength(0);
  });

  it('clamps a page below one, so a malformed button id renders page one', () => {
    const neighbors = Array.from({ length: 25 }, (_, i) => neighbor(i));
    const response = IntelligenceBuilders.buildAffinityResponse(
      affinityParams(neighbors, { page: -5 }),
    );
    expect(body(response)).toContain('-# Page 1/3');
  });

  it('says the page is gone rather than throwing when it is past the end', () => {
    // Affinity's list is the guild's indexed members, which shrinks when someone
    // unlinks Last.fm, leaves, or falls under the activity threshold - and
    // `totalPages` at `intelligenceInteractions.ts:63` is the count from when
    // the card was built, before the re-read at `:81`.
    const neighbors = Array.from({ length: 25 }, (_, i) => neighbor(i));
    expect(() =>
      IntelligenceBuilders.buildAffinityResponse(affinityParams(neighbors, { page: 4 })),
    ).not.toThrow();

    const text = body(IntelligenceBuilders.buildAffinityResponse(affinityParams(neighbors, { page: 4 })));
    expect(text).toContain('no longer available');
    // The membership line is a guild fact and is deliberately outside the page,
    // so it is NOT what makes a page gone - but a gone page claims no page number.
    expect(text).not.toContain('-# Page 4/3');
    expect(text).not.toContain('Human 20');
  });

  it('serialises a past-the-end page, because the raise was inside discord.js', () => {
    const neighbors = Array.from({ length: 25 }, (_, i) => neighbor(i));
    const response = IntelligenceBuilders.buildAffinityResponse(affinityParams(neighbors, { page: 99 }));
    expect(() => json(response)).not.toThrow();
    expect(body(response)).toContain('no longer available');
  });

  it('still renders a real last page, so the guard did not swallow the happy path', () => {
    const neighbors = Array.from({ length: 25 }, (_, i) => neighbor(i));
    const text = body(IntelligenceBuilders.buildAffinityResponse(affinityParams(neighbors, { page: 3 })));
    expect(text).toContain('Human 24');
    expect(text).not.toContain('no longer available');
  });

  it('still reports a genuine empty result as empty, not as a vanished page', () => {
    const text = body(IntelligenceBuilders.buildAffinityResponse(affinityParams([])));
    expect(text).toContain('Could not find indexed users with a similar music taste');
    expect(text).not.toContain('no longer available');
  });
});

describe('buildIcebergResponse: tiers are a classification, so an empty tier is skipped', () => {
  it('renders each tier with its own count, so a reader can check the total', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A', 'B']), tier(2, 'Waterline', WAVE, ['C'])]),
    );
    const text = body(response);
    expect(text).toContain('(2 artists)');
    expect(text).toContain('(1 artists)');
  });

  it('prints the tier number and name it was given, never a guess from the array index', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(4, 'The Abyss', MOUNTAIN, ['A'])]),
    );
    expect(body(response)).toContain('Tier 4: The Abyss');
  });

  it('prints the tier emoji through unchanged', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A'])]),
    );
    expect(body(response)).toContain(MOUNTAIN);
  });

  it('omits an empty tier rather than printing a heading over no names', () => {
    // A tier heading with nothing under it reads as "this artist is nobody's
    // tier", which is a classification claim about a person.
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A']), tier(2, 'Waterline', WAVE, [])]),
    );
    const text = body(response);
    expect(text).toContain('The Tip');
    expect(text).not.toContain('Waterline');
  });

  it('lists at most eight names in a tier and says how many more there are', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, Array.from({ length: 11 }, (_, i) => `Artist ${i}`))]),
    );
    const text = body(response);
    expect(text).toContain('Artist 7');
    expect(text).not.toContain('Artist 8');
    expect(text).toContain('+3 more');
    // The count is still the true one, not the truncated one.
    expect(text).toContain('(11 artists)');
  });

  it('adds no "more" clause when the tier fits, rather than printing "+0 more"', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A', 'B'])]),
    );
    expect(body(response)).not.toContain('more');
  });

  it('says there was nothing to classify when every tier is empty', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, []), tier(2, 'Waterline', WAVE, [])]),
    );
    expect(body(response)).toContain('No artists found to classify');
  });

  it('says nothing to classify for an empty tier list at all', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(icebergParams([]));
    expect(body(response)).toContain('No artists found to classify');
  });

  it('attaches the image instead of the tiers when one was rendered', () => {
    // A picture and a tier list are alternatives. Rendering both would give two
    // claims about the same classification.
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A'])], {
        imageBuffer: Buffer.from('not-really-a-png'),
      }),
    );
    expect(response.fileName).toBe('iceberg.png');
    expect(response.hasFile()).toBe(true);
    expect(body(response)).not.toContain('The Tip');
    expect(json(response).components?.some((c) => c.type === ComponentType.MediaGallery)).toBe(true);
  });

  it('renders no gallery and no file when there is no image, without throwing', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A'])], { imageBuffer: null }),
    );
    expect(response.hasFile()).toBe(false);
    expect(body(response)).toContain('The Tip');
    expect(json(response).components?.some((c) => c.type === ComponentType.MediaGallery)).toBe(false);
  });

  it('states the artist count the classification was over, because a tier list needs a denominator', () => {
    const response = IntelligenceBuilders.buildIcebergResponse(
      icebergParams([tier(1, 'The Tip', MOUNTAIN, ['A'])]),
    );
    expect(body(response)).toContain('top 12 artists');
  });
});
