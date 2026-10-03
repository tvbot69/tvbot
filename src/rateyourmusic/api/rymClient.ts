import { Logger } from '@domain/logging/logger';
import { fetchWithTimeout } from '@domain/http/fetchWithTimeout';
import type { RymArtist, RymRelease, RymReleaseStub } from '../models/rymModels';
import { parseArtistPage, parseChartPage, parseReleasePage } from './rymParsers';
import { RymOriginBlockError, RymTransport, type RymTransportConfig } from './rymTransport';

export { RymOriginBlockError, RymTransport };
export type { RymTransportConfig };

export const getChart = async (
  transport: RymTransport,
  path = '/charts/top/album/all-time/',
): Promise<RymReleaseStub[]> => {
  const page = await transport.getHtml(path);
  return parseChartPage(page.html);
};

export const getArtist = async (transport: RymTransport, slug: string): Promise<RymArtist> => {
  const page = await transport.getHtml(`/artist/${slug}`);
  return parseArtistPage(page.html, slug);
};

const waybackUrlFor = async (url: string): Promise<string | null> => {
  try {
    const check = await fetchWithTimeout(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      {},
      15000,
    );
    if (!check.ok) {
      return null;
    }
    const json = (await check.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string } };
    };
    const closest = json.archived_snapshots?.closest;
    return closest?.available && closest.url ? closest.url : null;
  } catch (err) {
    Logger.debug(`Wayback availability check failed for ${url}: ${String(err).slice(0, 120)}`);
    return null;
  }
};

export const getRelease = async (
  transport: RymTransport,
  slug: string,
  releaseType = 'album',
): Promise<RymRelease> => {
  const path = `/release/${releaseType}/${slug}/`;
  const url = `https://rateyourmusic.com${path}`;
  try {
    const page = await transport.getHtml(path);
    return parseReleasePage(page.html, slug);
  } catch (err) {
    if (err instanceof RymOriginBlockError) {
      Logger.debug(`RYM release blocked, trying Wayback for ${url}`);
      const waybackUrl = await waybackUrlFor(url);
      if (waybackUrl) {
        try {
          const snapshot = await fetchWithTimeout(waybackUrl, {}, 30000);
          if (snapshot.ok) {
            Logger.debug(`Serving ${url} from Wayback Machine`);
            return parseReleasePage(await snapshot.text(), slug);
          }
        } catch (waybackErr) {
          Logger.debug(`Wayback fetch failed for ${url}: ${String(waybackErr).slice(0, 120)}`);
        }
      }
    }
    throw err;
  }
};
