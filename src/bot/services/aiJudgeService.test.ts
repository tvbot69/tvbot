import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiJudgeService } from './aiJudgeService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';

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

  /**
   * The other half of the pair above, and the reason for it.
   *
   * Both reads used to end in `.catch(() => [])`, and `generateCritique` reads
   * an empty artist list as the punchline of the whole command. So a Last.fm
   * outage rated every user "0 / 10 - Ghost Town Scrobbles" and told them to go
   * and listen to some records - a confident, personalised, wrong answer with no
   * way for the user to suspect it was an outage.
   *
   * Asserted on the raise, not on the absence of "Ghost Town": the point is that
   * the failure leaves this service as a failure.
   */
  it('propagates a Last.fm outage rather than rating the user "Ghost Town"', async () => {
    vi.mocked(mockLastfmRepo.getTopArtists!).mockRejectedValue(
      new LastFmUnavailableError('user.gettopartists', new Error('Last.fm returned HTTP 500')),
    );
    vi.mocked(mockLastfmRepo.getTopTracks!).mockResolvedValue([
      { name: 'Creep', artistName: 'Radiohead', playcount: 150 },
    ]);

    await expect(
      service.evaluateTaste({
        userNameLastFm: 'test_user',
        discordUserId: '123456789',
        mode: 'roast',
      }),
    ).rejects.toBeInstanceOf(LastFmUnavailableError);
  });

  it('propagates a Last.fm outage on the track read as well', async () => {
    // The second `.catch` is a separate statement, so it is a separate hole:
    // fixing only the artists read leaves a judge that quotes "Unknown Track"
    // at someone from an outage.
    vi.mocked(mockLastfmRepo.getTopArtists!).mockResolvedValue([
      { name: 'Radiohead', playcount: 1200 },
    ]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockRejectedValue(
      new LastFmUnavailableError('user.gettoptracks', new Error('Last.fm returned HTTP 500')),
    );

    await expect(
      service.evaluateTaste({
        userNameLastFm: 'test_user',
        discordUserId: '123456789',
        mode: 'judge',
      }),
    ).rejects.toBeInstanceOf(LastFmUnavailableError);
  });
});
