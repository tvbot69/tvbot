import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { GameBuilders } from './gameBuilders';
import { JumbleSession, UserGameStats } from '@bot/services/gameService';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('GameBuilders', () => {
  const dummySession: JumbleSession = {
    sessionId: 'sess123',
    channelId: 'chan123',
    guildId: 'guild123',
    starterUserId: 'testuser',
    starterDiscordId: 'user123',
    type: 'artist',
    correctAnswer: 'Radiohead',
    displayTarget: 'A D E H I O A R',
    artistName: 'Radiohead',
    dateStarted: new Date(),
    hints: ['R _ _ _ _ _ _ _'],
    hintsShown: 0,
    blurLevel: 0.04,
    reshuffles: 0,
    ended: false,
  };

  describe('buildJumbleStartResponse', () => {
    it('creates a Components V2 response container with buttons', () => {
      const resp = GameBuilders.buildJumbleStartResponse(dummySession, 0x57f287);
      expect(resp.commandResponse).toBe(CommandResponse.Ok);
      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });

  describe('buildPixelStartResponse', () => {
    it('creates pixelation response with attached file and action rows', () => {
      const dummyPixelSession: JumbleSession = {
        ...dummySession,
        type: 'pixel',
        albumName: 'OK Computer',
        correctAnswer: 'OK Computer',
        coverUrl: 'https://example.com/cover.png',
      };
      const dummyBuffer = Buffer.from('dummy');
      const resp = GameBuilders.buildPixelStartResponse(dummyPixelSession, dummyBuffer, 0x57f287);
      expect(resp.commandResponse).toBe(CommandResponse.Ok);
      expect(resp.isComponentsV2).toBe(true);
      expect(resp.hasFile()).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });

  describe('buildGameWonResponse', () => {
    it('builds winning celebration response', () => {
      const wonSession: JumbleSession = {
        ...dummySession,
        winnerDiscordId: 'winner123',
        winnerName: 'WinningUser',
        ended: true,
        dateEnded: new Date(),
      };
      const stats: UserGameStats = {
        totalPlayed: 5,
        totalWon: 3,
        streak: 2,
        bestStreak: 3,
        avgTimeSeconds: 4.2,
      };

      const resp = GameBuilders.buildGameWonResponse(wonSession, 4.2, stats, 0x57f287);
      expect(resp.commandResponse).toBe(CommandResponse.Ok);
      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });

  describe('buildGameExpiredResponse', () => {
    it('formats expired game response with the correct answer revealed', () => {
      const expiredSession: JumbleSession = {
        ...dummySession,
        ended: true,
      };
      const resp = GameBuilders.buildGameExpiredResponse(expiredSession);
      expect(resp.commandResponse).toBe(CommandResponse.Ok);
      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });

  describe('buildGameGiveUpResponse', () => {
    it('formats give up response', () => {
      const gaveUpSession: JumbleSession = {
        ...dummySession,
        ended: true,
      };
      const resp = GameBuilders.buildGameGiveUpResponse(gaveUpSession);
      expect(resp.commandResponse).toBe(CommandResponse.Ok);
      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });

  describe('buildGameStatsResponse', () => {
    it('formats user game statistics overview', () => {
      const stats: UserGameStats = {
        totalPlayed: 10,
        totalWon: 8,
        streak: 4,
        bestStreak: 6,
        avgTimeSeconds: 3.1,
      };

      const resp = GameBuilders.buildGameStatsResponse('Alice', stats, 0x3d5ef2);
      expect(resp.commandResponse).toBe(CommandResponse.Ok);
      expect(resp.isComponentsV2).toBe(true);
      expect(resp.componentsV2Container).toBeDefined();
    });
  });
});
