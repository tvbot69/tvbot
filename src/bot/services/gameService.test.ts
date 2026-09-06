import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameService, JumbleSession } from './gameService';

describe('GameService', () => {
  describe('normalizeAnswer', () => {
    it('normalizes diacritics and casing', () => {
      expect(GameService.normalizeAnswer('Björk')).toBe('bjork');
      expect(GameService.normalizeAnswer('Sigur Rós')).toBe('sigur ros');
      expect(GameService.normalizeAnswer('Mötley Crüe')).toBe('motley crue');
      expect(GameService.normalizeAnswer('Beyoncé')).toBe('beyonce');
    });

    it('strips punctuation and special characters', () => {
      expect(GameService.normalizeAnswer('Panic! At The Disco')).toBe('panic at the disco');
      expect(GameService.normalizeAnswer('AC/DC')).toBe('ac dc');
      expect(GameService.normalizeAnswer('Tyler, The Creator')).toBe('tyler the creator');
      expect(GameService.normalizeAnswer('Wham!')).toBe('wham');
    });

    it('removes parenthetical remarks like (Deluxe Edition) or (Remastered)', () => {
      expect(GameService.normalizeAnswer('OK Computer (OKNOTOK 1997 2017)')).toBe('ok computer');
      expect(GameService.normalizeAnswer('In Rainbows [Deluxe]')).toBe('in rainbows');
    });
  });

  describe('getLevenshteinDistance', () => {
    it('calculates accurate distance', () => {
      expect(GameService.getLevenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(GameService.getLevenshteinDistance('radiohead', 'radiohead')).toBe(0);
      expect(GameService.getLevenshteinDistance('radiohead', 'radiohed')).toBe(1);
    });
  });

  describe('answerIsRight', () => {
    it('matches exact answers regardless of case and punctuation', () => {
      expect(GameService.answerIsRight('Radiohead', 'radiohead')).toBe(true);
      expect(GameService.answerIsRight('Tyler, The Creator', 'tyler the creator')).toBe(true);
      expect(GameService.answerIsRight('Björk', 'bjork')).toBe(true);
    });

    it('matches with minor typos using Levenshtein fuzzy tolerance', () => {
      expect(GameService.answerIsRight('Radiohead', 'radihead')).toBe(true);
      expect(GameService.answerIsRight('Kendrick Lamar', 'kendrik lamar')).toBe(true);
    });

    it('rejects incorrect answers', () => {
      expect(GameService.answerIsRight('Radiohead', 'Coldplay')).toBe(false);
      expect(GameService.answerIsRight('Nirvana', 'Nir')).toBe(false);
      expect(GameService.answerIsRight('The Beatles', 'The Rolling Stones')).toBe(false);
    });
  });

  describe('jumbleWord & jumbleWords', () => {
    it('preserves word counts and letter counts', () => {
      const original = 'Radiohead';
      const jumbled = GameService.jumbleWords(original);
      expect(jumbled.length).toBe(original.length);
      expect(jumbled.toLowerCase().split('').sort().join('')).toBe(
        original.toLowerCase().split('').sort().join(''),
      );
    });

    it('handles multi-word titles', () => {
      const original = 'Pink Floyd';
      const jumbled = GameService.jumbleWords(original);
      const parts = jumbled.split(' ');
      expect(parts.length).toBe(2);
      expect(parts[0]!.length).toBe(4);
      expect(parts[1]!.length).toBe(5);
    });
  });

  describe('getLetterClue', () => {
    it('reveals first letter of words and masks others with underscores', () => {
      const clue = GameService.getLetterClue('Pink Floyd');
      expect(clue).toBe('P _ _ _   F _ _ _ _');
    });

    it('handles single word', () => {
      const clue = GameService.getLetterClue('Nirvana');
      expect(clue).toBe('N _ _ _ _ _ _');
    });
  });

  describe('Game Session Management', () => {
    let gameService: GameService;

    beforeEach(() => {
      gameService = new GameService();
    });

    it('starts, retrieves, and checks answer for a Jumble game', () => {
      const onExpire = vi.fn();
      const session = gameService.startGame({
        channelId: 'channel-123',
        guildId: 'guild-123',
        starterUserId: 'testuser',
        starterDiscordId: 'user-456',
        type: 'artist',
        correctAnswer: 'Radiohead',
        artistName: 'Radiohead',
        onExpire,
      });

      expect(session).toBeDefined();
      expect(session.ended).toBe(false);
      expect(gameService.getActiveGame('channel-123')).toBe(session);
      expect(gameService.getActiveGameById(session.sessionId)).toBe(session);

      // Incorrect answer
      const wrong = gameService.checkAnswer('channel-123', 'user-789', 'Bob', 'Coldplay');
      expect(wrong.isCorrect).toBe(false);
      expect(session.ended).toBe(false);

      // Correct answer
      const right = gameService.checkAnswer('channel-123', 'user-789', 'Bob', 'radiohead');
      expect(right.isCorrect).toBe(true);
      expect(right.session?.winnerDiscordId).toBe('user-789');
      expect(right.session?.ended).toBe(true);
      expect(gameService.getActiveGame('channel-123')).toBeUndefined();

      // Stats check
      const stats = gameService.getUserStats('user-789');
      expect(stats.totalWon).toBe(1);
      expect(stats.streak).toBe(1);
    });

    it('handles give up action', () => {
      const onExpire = vi.fn();
      const session = gameService.startGame({
        channelId: 'channel-456',
        guildId: 'guild-123',
        starterUserId: 'testuser',
        starterDiscordId: 'user-456',
        type: 'artist',
        correctAnswer: 'Kendrick Lamar',
        artistName: 'Kendrick Lamar',
        onExpire,
      });

      const ended = gameService.giveUp(session.sessionId);
      expect(ended).toBeDefined();
      expect(ended?.ended).toBe(true);
      expect(gameService.getActiveGame('channel-456')).toBeUndefined();
    });

    it('provides hints and reshuffles', () => {
      const onExpire = vi.fn();
      const session = gameService.startGame({
        channelId: 'channel-789',
        guildId: 'guild-123',
        starterUserId: 'testuser',
        starterDiscordId: 'user-456',
        type: 'artist',
        correctAnswer: 'Gorillaz',
        artistName: 'Gorillaz',
        onExpire,
      });

      const hint = gameService.nextHint(session.sessionId);
      expect(hint).toBeDefined();
      expect(hint?.hint).toBeDefined();

      const reshuffled = gameService.reshuffle(session.sessionId);
      expect(reshuffled).toBeDefined();
      expect(session.reshuffles).toBe(1);

      gameService.endGame(session.sessionId);
    });
  });
});
