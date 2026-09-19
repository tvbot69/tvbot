import { describe, it, expect } from 'vitest';
import { normalizeStoredName } from './textNormalize';

describe('normalizeStoredName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeStoredName('  Mond  ')).toBe('Mond');
    expect(normalizeStoredName('Mo   nd')).toBe('Mo nd');
  });

  it('strips invisible characters', () => {
    const zwsp = String.fromCharCode(0x200b);
    const bom = String.fromCharCode(0xfeff);
    expect(normalizeStoredName(`Mo${zwsp}nd`)).toBe('Mond');
    expect(normalizeStoredName(`Esme${bom}`)).toBe('Esme');
  });

  it('preserves casing and safe input', () => {
    expect(normalizeStoredName('Playboi Carti')).toBe('Playboi Carti');
    expect(normalizeStoredName(null)).toBe('');
    expect(normalizeStoredName(undefined)).toBe('');
  });
});
