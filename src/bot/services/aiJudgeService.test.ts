import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiJudgeService } from './aiJudgeService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { TimePeriod } from '@domain/enums/timePeriod';

describe('AiJudgeService', () => {
  let service: AiJudgeService;
  let mockLastfmRepo: Partial<ILastfmRepository>;

  beforeEach(() => {
    mockLastfmRepo = {
      getTopArtists: vi.fn(),
      getTopTracks: vi.fn(),
    };

    service = new AiJudgeService(mockLastfmRepo as ILastfmRepository);
  });

  it('evaluates taste with roast mode and generates sarcastic critique', async () => {
    vi.mocked(mockLastfmRepo.getTopArtists!).mockResolvedValue([
      { name: 'Radiohead', playcount: 1200 },
      { name: 'The Smiths', playcount: 800 },
    ]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockResolvedValue([
      { name: 'Creep', artistName: 'Radiohead', playcount: 150 },
    ]);

    const result = await service.evaluateTaste({
      userNameLastFm: 'test_user',
      discordUserId: '123456789',
      mode: 'roast',
      period: TimePeriod.Quarterly,
    });

    expect(result.mode).toBe('roast');
    expect(result.topArtists).toContain('Radiohead');
    expect(result.critique).toContain('Radiohead');
    expect(result.rating).toMatch(/\d\.\d \/ 10/);
  });

  it('evaluates taste with compliment mode', async () => {
    vi.mocked(mockLastfmRepo.getTopArtists!).mockResolvedValue([
      { name: 'Aphex Twin', playcount: 500 },
      { name: 'Boards of Canada', playcount: 450 },
    ]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockResolvedValue([
      { name: 'Rhubarb', artistName: 'Aphex Twin', playcount: 80 },
    ]);

    const result = await service.evaluateTaste({
      userNameLastFm: 'test_user',
      discordUserId: '123456789',
      mode: 'compliment',
      period: TimePeriod.Quarterly,
    });

    expect(result.mode).toBe('compliment');
    expect(result.critique).toContain('Aphex Twin');
    expect(result.headline).toContain('Impeccable Taste');
  });

  it('evaluates taste with balanced judge mode', async () => {
    vi.mocked(mockLastfmRepo.getTopArtists!).mockResolvedValue([
      { name: 'Kendrick Lamar', playcount: 700 },
      { name: 'Miles Davis', playcount: 300 },
    ]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockResolvedValue([]);

    const result = await service.evaluateTaste({
      userNameLastFm: 'test_user',
      discordUserId: '123456789',
      mode: 'judge',
    });

    expect(result.mode).toBe('judge');
    expect(result.critique).toContain('Kendrick Lamar');
  });

  it('handles empty listening history gracefully', async () => {
    vi.mocked(mockLastfmRepo.getTopArtists!).mockResolvedValue([]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockResolvedValue([]);

    const result = await service.evaluateTaste({
      userNameLastFm: 'empty_user',
      discordUserId: '123456789',
      mode: 'judge',
    });

    expect(result.rating).toBe('0 / 10');
    expect(result.headline).toContain('Ghost Town');
  });
});
