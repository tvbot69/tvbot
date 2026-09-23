import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MusicBuilders } from './musicBuilders';

describe('buildLyricSection', () => {
  it('renders current big plus next small (V2)', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: 'Is it me' })).toBe(
      '## Hello\n-# Is it me',
    );
  });

  it('omits the next line when the song ends', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Goodbye', next: null })).toBe('## Goodbye');
  });

  it('shows the upcoming line before the first timestamp', () => {
    expect(MusicBuilders.buildLyricSection({ current: null, next: 'Hello' })).toBe('-# Hello');
  });

  it('returns null when nothing is singable', () => {
    expect(MusicBuilders.buildLyricSection(null)).toBeNull();
    expect(MusicBuilders.buildLyricSection({ current: null, next: null })).toBeNull();
  });

  it('renders embed-safe markdown for the legacy fallback', () => {
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: 'Is it me' }, false)).toBe(
      '🎤 **Hello**\n*Is it me*',
    );
    expect(MusicBuilders.buildLyricSection({ current: 'Hello', next: null }, false)).toBe('🎤 **Hello**');
    expect(MusicBuilders.buildLyricSection(null, false)).toBeNull();
  });
});
