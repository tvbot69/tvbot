import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { TopArtist, TopTrack } from '@domain/models/topLists';
import { TimePeriod } from '@domain/enums/timePeriod';

export type JudgeMode = 'judge' | 'roast' | 'compliment';

export interface JudgeResult {
  mode: JudgeMode;
  userNameLastFm: string;
  discordUserId: string;
  rating: string;
  headline: string;
  critique: string;
  topArtists: string[];
  topTracks: string[];
  period: TimePeriod;
}

@injectable()
export class AiJudgeService {
  constructor(
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
  ) {}

  public async evaluateTaste(params: {
    userNameLastFm: string;
    discordUserId: string;
    mode: JudgeMode;
    period?: TimePeriod;
  }): Promise<JudgeResult> {
    const period = params.period ?? TimePeriod.Quarterly;

    // Fetch top artists and top tracks for the period
    const [artists, tracks] = await Promise.all([
      this.lastFmRepository.getTopArtists(params.userNameLastFm, period, 15).catch(() => [] as TopArtist[]),
      this.lastFmRepository.getTopTracks(params.userNameLastFm, period, 15).catch(() => [] as TopTrack[]),
    ]);

    const topArtistNames = artists.slice(0, 5).map((a: TopArtist) => a.name);
    const topTrackNames = tracks.slice(0, 5).map((t: TopTrack) => `${t.name} by ${t.artistName}`);

    const evaluation = this.generateCritique({
      userName: params.userNameLastFm,
      artists,
      tracks,
      mode: params.mode,
    });

    return {
      mode: params.mode,
      userNameLastFm: params.userNameLastFm,
      discordUserId: params.discordUserId,
      rating: evaluation.rating,
      headline: evaluation.headline,
      critique: evaluation.critique,
      topArtists: topArtistNames,
      topTracks: topTrackNames,
      period,
    };
  }

  private generateCritique(params: {
    userName: string;
    artists: TopArtist[];
    tracks: TopTrack[];
    mode: JudgeMode;
  }): { rating: string; headline: string; critique: string } {
    const { artists, tracks, mode } = params;

    if (artists.length === 0) {
      return {
        rating: '0 / 10',
        headline: 'Ghost Town Scrobbles',
        critique: "There isn't enough listening data to pass judgment yet. Go listen to some records and come back when your library has signs of life!",
      };
    }

    const topArtist = artists[0]?.name ?? 'Unknown';
    const topArtistPlays = artists[0]?.playcount ?? 0;
    const secondArtist = artists[1]?.name ?? 'Various Artists';
    const totalTopPlays = artists.reduce((acc, a) => acc + (a.playcount ?? 0), 0);

    const skewRatio = totalTopPlays > 0 ? topArtistPlays / totalTopPlays : 0;
    const topTrack = tracks[0]?.name ?? 'Unknown Track';

    if (mode === 'roast') {
      let ratingNum = 2 + Math.floor(Math.random() * 4); // 2-5
      let headline = `Addicted to ${topArtist} & In Serious Denial`;
      let paragraphs: string[] = [];

      if (skewRatio > 0.45) {
        headline = `Single-Artist Obsession Syndrome: ${topArtist}`;
        paragraphs.push(
          `Do you know other musicians exist, or does your music player only have a giant button that says **${topArtist}**? With **${topArtistPlays.toLocaleString()} plays**, you're single-handedly funding their next vacation home while completely starving your ear drums of musical variety.`,
        );
      } else {
        paragraphs.push(
          `Your music taste looks like an algorithm had an existential crisis and threw together **${topArtist}**, **${secondArtist}**, and a bunch of tracks you probably pretend to understand at hipster dinner parties.`,
        );
      }

      if (tracks.length > 0) {
        paragraphs.push(
          `Playing \`${topTrack}\` on repeat won't make your crush text you back, but here we are. It's giving "I based my entire personality around a 2018 indie Spotify editorial playlist."`,
        );
      }

      paragraphs.push(
        `**Verdict**: Step outside, touch some vinyl, and maybe listen to an album made before or after your hyper-fixation began.`,
      );

      return {
        rating: `${ratingNum}.${Math.floor(Math.random() * 9)} / 10`,
        headline,
        critique: paragraphs.join('\n\n'),
      };
    }

    if (mode === 'compliment') {
      let ratingNum = 8 + Math.floor(Math.random() * 2); // 8-9
      let headline = `Impeccable Taste with Deep Sonic Depth`;
      let paragraphs: string[] = [];

      paragraphs.push(
        `Leading with **${topArtist}** (**${topArtistPlays.toLocaleString()} plays**) followed by **${secondArtist}** shows a listener who actually commits to artist discographies rather than casually skimming radio hits. You clearly appreciate cohesive albums and intentional songwriting.`,
      );

      if (tracks.length > 0) {
        paragraphs.push(
          `Having \`${topTrack}\` in high rotation is a massive badge of honor. It highlights an ear for standout melodic texture and pristine production value. Your queue is the kind people would gladly surrender aux cord privileges to on a late-night drive.`,
        );
      }

      paragraphs.push(
        `**Verdict**: Exceptional curation with a refined sonic palette. You're a certified music connoisseur.`,
      );

      return {
        rating: `${ratingNum}.${Math.floor(Math.random() * 9)} / 10`,
        headline,
        critique: paragraphs.join('\n\n'),
      };
    }

    // Balanced 'judge' mode
    let ratingNum = 6 + Math.floor(Math.random() * 3); // 6-8
    let headline = `The Cautious Eclectic: High Potential, Distinct Habits`;
    let paragraphs: string[] = [];

    paragraphs.push(
      `Your library displays strong foundational taste anchored by **${topArtist}** (**${topArtistPlays.toLocaleString()} plays**) and **${secondArtist}**. There's genuine musical substance here, avoiding superficial viral trends in favor of established artistic identities.`,
    );

    if (skewRatio > 0.4) {
      paragraphs.push(
        `However, your reliance on **${topArtist}** is bordering on a comfort-zone crutch. Expanding into related underground scenes or branching deeper into neighboring subgenres would elevate your rotation from solid to extraordinary.`,
      );
    } else {
      paragraphs.push(
        `Your rotation is refreshingly balanced between major staples and selective deep cuts like \`${topTrack}\`. You let songs breathe without burning out on any single artist too quickly.`,
      );
    }

    paragraphs.push(
      `**Verdict**: Solid taste with clear musical direction and respectable curation standards.`,
    );

    return {
      rating: `${ratingNum}.${Math.floor(Math.random() * 9)} / 10`,
      headline,
      critique: paragraphs.join('\n\n'),
    };
  }
}
