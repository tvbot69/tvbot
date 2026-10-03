import { Logger } from '@domain/logging/logger';

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export const cleanText = (text: string): string => {
  if (!text) {
    return '';
  }
  let out = text;
  out = out.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
  out = out.normalize('NFKC');
  out = out.replace(/\s+/g, ' ');
  return out.trim();
};

export const parseYear = (text: string): number | null => {
  const match = /\b(?:19|20)\d{2}\b/.exec(text);
  return match ? Number(match[0]) : null;
};

export const parseRating = (text: string): number | null => {
  const match = /(\d\.\d{1,2})/.exec(text.trim());
  return match ? Number(match[1]) : null;
};

export const parseCount = (text: string): number | null => {
  if (!text) {
    return null;
  }
  const normalized = cleanText(text).toLowerCase().replace(/,/g, '');
  const match = /(\d+(?:\.\d+)?)\s*([km]?)/.exec(normalized);
  if (!match || match[1] === undefined) {
    return null;
  }
  let value = Number(match[1]);
  if (match[2] === 'k') {
    value *= 1000;
  } else if (match[2] === 'm') {
    value *= 1_000_000;
  }
  return Math.round(value);
};

export const releaseSlugFromUrl = (url: string): string => {
  if (!url) {
    return '';
  }
  try {
    const path = new URL(url, 'https://rateyourmusic.com').pathname;
    const parts = path.split('/').filter((p) => p.length > 0);
    if (parts.length >= 4 && parts[0] === 'release') {
      return `${parts[2]}/${parts[3]}`;
    }
    return '';
  } catch (err) {
    Logger.debug(`releaseSlugFromUrl failed for ${url.slice(0, 80)}: ${String(err).slice(0, 80)}`);
    return '';
  }
};

export const releaseTypeFromUrl = (url: string): string => {
  try {
    const parts = new URL(url, 'https://rateyourmusic.com').pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0] === 'release') {
      return parts[1] ?? 'album';
    }
    return 'album';
  } catch (err) {
    Logger.debug(`releaseTypeFromUrl failed for ${url.slice(0, 80)}: ${String(err).slice(0, 80)}`);
    return 'album';
  }
};

export const artistSlugFromUrl = (url: string): string => {
  if (!url) {
    return '';
  }
  try {
    const parts = new URL(url, 'https://rateyourmusic.com').pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0] === 'artist') {
      return parts[1] ?? '';
    }
    return parts[parts.length - 1] ?? '';
  } catch (err) {
    Logger.debug(`artistSlugFromUrl failed for ${url.slice(0, 80)}: ${String(err).slice(0, 80)}`);
    return '';
  }
};

export const absoluteUrl = (url: string): string => {
  if (!url) {
    return '';
  }
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  try {
    return new URL(url, 'https://rateyourmusic.com').toString();
  } catch (err) {
    Logger.debug(`absoluteUrl failed for ${url.slice(0, 80)}: ${String(err).slice(0, 80)}`);
    return '';
  }
};
