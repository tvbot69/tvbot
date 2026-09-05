import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { LibrarySearchBuilders } from './librarySearchBuilders';
import { SearchTab } from '@bot/services/librarySearchService';

describe('LibrarySearchBuilders', () => {
  it('builds library search page with tabs and pagination matching fmbot 1:1', () => {
    const response = LibrarySearchBuilders.buildSearchResponse({
      query: 'strokes',
      tab: SearchTab.Artists,
      page: 0,
      allRows: [
        { primary: 'the strokes', count: 3010, rank: 3 },
      ],
      cacheKey: 'testcache',
      targetDiscordUserId: '687636049576722472',
      accentColor: 0xa6006c,
    });

    expect(response.embed).toBeDefined();
    const desc = response.embed.data.description ?? '';
    expect(desc).toContain("### 🔎 Search results for 'strokes'");
    expect(desc).toContain('-# 1 match in your cached artists');
    expect(desc).toContain('**`#3`**  **[the strokes](https://last.fm/music/the%20strokes)** - *3,010 plays*');

    const actionRows = response.buildComponents();
    expect(actionRows.length).toBe(2);
    // Nav row
    expect(actionRows[0]!.components.length).toBe(2);
    // Tab row
    expect(actionRows[1]!.components.length).toBe(4);
  });
});
