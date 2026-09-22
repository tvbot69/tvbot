import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsRepository } from './whoKnowsRepository';

describe('WhoKnowsRepository artist dedup', () => {
  it('aggregates one row per user across case-variant duplicates', async () => {
    const $queryRaw = vi.fn(async () => [{ userId: 1, playcount: 200 }]);
    const repo = new WhoKnowsRepository({ $queryRaw } as never);
    const rows = await repo.getIndexedUsersForArtist('1', 'Mac DeMarco');
    expect(rows).toEqual([{ userId: 1, playcount: 200 }]);
    const rawCall = $queryRaw.mock.calls[0] as unknown[] | undefined;
    const sql = String((rawCall?.[0] as TemplateStringsArray).join(' '));
    expect(sql).toMatch(/GROUP BY/i);
    expect(sql).toMatch(/SUM/i);
  });
});
