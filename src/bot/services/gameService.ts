import { injectable, inject } from 'tsyringe';
import crypto from 'crypto';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { CacheService } from './cacheService';
import { CountryService, CountryInfo } from './countryService';

export type JumbleType = 'artist' | 'pixel';

export interface JumbleSession {
  sessionId: string;
  channelId: string;
  guildId?: string;
  starterUserId: string;
  starterDiscordId: string;
  type: JumbleType;
  correctAnswer: string;
  displayTarget: string;
  artistName: string;
  albumName?: string;
  coverUrl?: string;
  dateStarted: Date;
  dateEnded?: Date;
  timeoutHandle?: NodeJS.Timeout;
  hints: string[];
  hintsShown: number;
  blurLevel: number;
  reshuffles: number;
  ended: boolean;
  winnerDiscordId?: string;
  winnerName?: string;
  messageId?: string;
}

export interface UserGameStats {
  totalPlayed: number;
  totalWon: number;
  streak: number;
  bestStreak: number;
  avgTimeSeconds: number;
  lastPlayedDate?: string;
}

@injectable()
export class GameService {
  public static readonly JumbleSecondsToGuess = 25;
  public static readonly PixelationSecondsToGuess = 40;

  private activeSessionsByChannel = new Map<string, JumbleSession>();
  private activeSessionsById = new Map<string, JumbleSession>();
  private userStats = new Map<string, UserGameStats>();

  constructor(
    @inject(PuppeteerService) private readonly puppeteerService?: PuppeteerService,
  ) {}

  public static normalizeAnswer(input: string): string {
    if (!input) return '';

    // Strip parenthesized or bracketed suffixes like (Deluxe Edition), (Remastered), [Bonus Track]
    let normalized = input.trim().replace(/\s*[\(\[][^)]*?[\)\]]/gi, '');
    normalized = normalized.normalize('NFD');

    // Replace non-spacing marks (diacritics/accents)
    normalized = normalized.replace(/[\u0300-\u036f]/g, '');

    // Map common musical / international characters
    normalized = normalized
      .replace(/Ø/g, 'O')
      .replace(/ø/g, 'o')
      .replace(/ß/g, 'ss')
      .replace(/æ/g, 'ae')
      .replace(/Æ/g, 'Ae')
      .replace(/å/g, 'a')
      .replace(/Å/g, 'A')
      .replace(/Λ/g, 'A')
      .replace(/&/g, 'and')
      .replace(/[?!'’‘`´…:;,\-_/()"[\]{}*~^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    return normalized;
  }

  public static getLevenshteinDistance(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0) return len2;
    if (len2 === 0) return len1;

    const matrix: number[][] = [];
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0]![j] = j;
    }

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j - 1]! + cost,
        );
      }
    }

    return matrix[len1]![len2]!;
  }

  public static answerIsRight(correctAnswer: string, userInput: string): boolean {
    if (!correctAnswer || !userInput) return false;

    const normCorrect = GameService.normalizeAnswer(correctAnswer);
    const normUser = GameService.normalizeAnswer(userInput);

    if (!normCorrect || !normUser) return false;

    // Exact or substring match
    if (normCorrect === normUser) return true;
    if (normUser.includes(normCorrect) && normUser.length <= normCorrect.length + 4) return true;

    // Levenshtein fuzzy distance tolerance
    const dist = GameService.getLevenshteinDistance(normUser, normCorrect);
    if (normCorrect.length > 4 && dist <= 1) return true;
    if (normCorrect.length > 10 && dist <= 2) return true;

    return false;
  }

  public static jumbleWord(word: string): string {
    if (word.length <= 2) return word;
    const chars = word.split('');
    const orig = chars.join('');

    for (let attempts = 0; attempts < 5; attempts++) {
      for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = chars[i]!;
        chars[i] = chars[j]!;
        chars[j] = temp;
      }
      if (chars.join('') !== orig) break;
    }

    return chars.join('');
  }

  public static jumbleWords(phrase: string): string {
    return phrase
      .split(' ')
      .map(w => GameService.jumbleWord(w))
      .join(' ');
  }

  public static getLetterClue(phrase: string): string {
    const words = phrase.split(' ');
    const maskedWords = words.map(word => {
      if (word.length <= 2) return word;
      const letters = word.split('');
      const first = letters[0];
      const rest = letters.slice(1).map(c => (/[a-zA-Z0-9]/.test(c) ? '_' : c)).join(' ');
      return `${first} ${rest}`;
    });
    return maskedWords.join('   ');
  }

  public async pixelateCover(coverUrl: string, pixelRatio = 0.04): Promise<Buffer> {
    try {
      const res = await fetch(coverUrl);
      if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
      const arrayBuf = await res.arrayBuffer();
      const b64 = Buffer.from(arrayBuf).toString('base64');
      const mime = res.headers.get('content-type') || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${b64}`;

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;overflow:hidden;background:#000;">
<canvas id="c" width="500" height="500"></canvas>
<img id="srcImg" src="${dataUrl}" style="display:none;" />
<script>
const img = document.getElementById('srcImg');
const render = () => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const small = document.createElement('canvas');
  const sCtx = small.getContext('2d');
  const blocks = Math.max(6, Math.round(500 * ${pixelRatio}));
  small.width = blocks;
  small.height = blocks;
  sCtx.drawImage(img, 0, 0, blocks, blocks);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, 500, 500);
};
if (img.complete) render();
else img.onload = render;
</script>
</body>
</html>`;

      if (!this.puppeteerService) {
        throw new Error('PuppeteerService is not available');
      }
      return await this.puppeteerService.screenshotHtml(html, 500, 500);
    } catch {
      // Return 1x1 black pixel fallback on network error
      return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
    }
  }

  public getActiveGame(channelId: string): JumbleSession | undefined {
    return this.activeSessionsByChannel.get(channelId);
  }

  public getActiveGameById(sessionId: string): JumbleSession | undefined {
    return this.activeSessionsById.get(sessionId);
  }

  public startGame(params: {
    channelId: string;
    guildId?: string;
    starterUserId: string;
    starterDiscordId: string;
    type: JumbleType;
    correctAnswer: string;
    artistName: string;
    albumName?: string;
    coverUrl?: string;
    hints?: string[];
    onExpire: (session: JumbleSession) => Promise<void>;
  }): JumbleSession {
    const existing = this.activeSessionsByChannel.get(params.channelId);
    if (existing && !existing.ended) {
      this.endGame(existing.sessionId);
    }

    const sessionId = crypto.randomBytes(6).toString('hex');
    const seconds =
      params.type === 'pixel'
        ? GameService.PixelationSecondsToGuess
        : GameService.JumbleSecondsToGuess;

    const displayTarget =
      params.type === 'artist'
        ? GameService.jumbleWords(params.correctAnswer).toUpperCase()
        : '';

    const hints = params.hints ?? [];
    if (hints.length === 0) {
      hints.push(GameService.getLetterClue(params.correctAnswer));
    }

    const session: JumbleSession = {
      sessionId,
      channelId: params.channelId,
      guildId: params.guildId,
      starterUserId: params.starterUserId,
      starterDiscordId: params.starterDiscordId,
      type: params.type,
      correctAnswer: params.correctAnswer,
      displayTarget,
      artistName: params.artistName,
      albumName: params.albumName,
      coverUrl: params.coverUrl,
      dateStarted: new Date(),
      hints,
      hintsShown: 0,
      blurLevel: 0.04,
      reshuffles: 0,
      ended: false,
    };

    session.timeoutHandle = setTimeout(async () => {
      if (!session.ended) {
        session.ended = true;
        session.dateEnded = new Date();
        this.activeSessionsByChannel.delete(session.channelId);
        this.activeSessionsById.delete(session.sessionId);
        await params.onExpire(session);
      }
    }, seconds * 1000);

    this.activeSessionsByChannel.set(params.channelId, session);
    this.activeSessionsById.set(sessionId, session);

    return session;
  }

  public checkAnswer(
    channelId: string,
    userDiscordId: string,
    userName: string,
    messageContent: string,
  ): { isCorrect: boolean; session?: JumbleSession; timeSeconds?: number } {
    const session = this.activeSessionsByChannel.get(channelId);
    if (!session || session.ended) return { isCorrect: false };

    if (GameService.answerIsRight(session.correctAnswer, messageContent)) {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
      session.ended = true;
      session.dateEnded = new Date();
      session.winnerDiscordId = userDiscordId;
      session.winnerName = userName;

      const timeSeconds = (session.dateEnded.getTime() - session.dateStarted.getTime()) / 1000;

      this.activeSessionsByChannel.delete(channelId);
      this.activeSessionsById.delete(session.sessionId);

      this.recordWin(userDiscordId, timeSeconds);

      return { isCorrect: true, session, timeSeconds };
    }

    return { isCorrect: false, session };
  }

  public reshuffle(sessionId: string): string | undefined {
    const session = this.activeSessionsById.get(sessionId);
    if (!session || session.ended || session.type !== 'artist') return undefined;

    session.reshuffles++;
    session.displayTarget = GameService.jumbleWords(session.correctAnswer).toUpperCase();
    return session.displayTarget;
  }

  public nextHint(sessionId: string): { hint?: string; blurLevel?: number } | undefined {
    const session = this.activeSessionsById.get(sessionId);
    if (!session || session.ended) return undefined;

    if (session.type === 'pixel') {
      session.blurLevel = Math.min(0.12, session.blurLevel + 0.04);
      return { blurLevel: session.blurLevel };
    }

    if (session.hintsShown < session.hints.length) {
      const hint = session.hints[session.hintsShown];
      session.hintsShown++;
      return { hint };
    }

    return undefined;
  }

  public giveUp(sessionId: string): JumbleSession | undefined {
    const session = this.activeSessionsById.get(sessionId);
    if (!session || session.ended) return undefined;

    if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
    session.ended = true;
    session.dateEnded = new Date();

    this.activeSessionsByChannel.delete(session.channelId);
    this.activeSessionsById.delete(sessionId);

    return session;
  }

  public endGame(sessionId: string): void {
    const session = this.activeSessionsById.get(sessionId);
    if (session) {
      if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
      session.ended = true;
      session.dateEnded = new Date();
      this.activeSessionsByChannel.delete(session.channelId);
      this.activeSessionsById.delete(sessionId);
    }
  }

  public recordWin(discordUserId: string, timeSeconds: number): void {
    const current = this.userStats.get(discordUserId) ?? {
      totalPlayed: 0,
      totalWon: 0,
      streak: 0,
      bestStreak: 0,
      avgTimeSeconds: 0,
    };

    const todayStr = new Date().toISOString().slice(0, 10);
    const wasYesterday =
      current.lastPlayedDate &&
      new Date(current.lastPlayedDate).getTime() >= Date.now() - 48 * 3600 * 1000;

    current.totalPlayed++;
    current.totalWon++;
    current.streak = wasYesterday ? current.streak + 1 : 1;
    if (current.streak > current.bestStreak) {
      current.bestStreak = current.streak;
    }
    current.lastPlayedDate = todayStr;

    // Moving average time
    current.avgTimeSeconds =
      current.avgTimeSeconds === 0
        ? timeSeconds
        : current.avgTimeSeconds * 0.8 + timeSeconds * 0.2;

    this.userStats.set(discordUserId, current);
  }

  public getUserStats(discordUserId: string): UserGameStats {
    return (
      this.userStats.get(discordUserId) ?? {
        totalPlayed: 0,
        totalWon: 0,
        streak: 0,
        bestStreak: 0,
        avgTimeSeconds: 0,
      }
    );
  }
}
