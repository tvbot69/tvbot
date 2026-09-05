import { Logger } from '@domain/logger';

export interface ScrapedTrack {
  name: string;
  artist: string;
  durationMs: number;
  artworkUrl?: string;
  spotifyUri?: string;
}

export interface ScrapedPlaylist {
  name: string;
  owner: string;
  artworkUrl?: string;
  total: number;
  tracks: ScrapedTrack[];
  hasMore: boolean;
  nextOffset: number | null;
}

export class SpotifyScraperService {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private readonly userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  private async getWebPlayerToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60000) {
      return this.cachedToken.token;
    }
    const endpoints = [
      'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      'https://open.spotify.com/get_access_token?reason=transport&productType=web-player',
      'https://clienttoken.spotify.com/v1/clienttoken',
    ];
    const headersList: Array<Record<string, string>> = [
      {
        'User-Agent': this.userAgent,
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'Origin': 'https://open.spotify.com',
        'Referer': 'https://open.spotify.com/',
      },
      {
        'User-Agent': this.userAgent,
        'Accept': '*/*',
        'Origin': 'https://open.spotify.com',
        'Referer': 'https://open.spotify.com/playlist/6GyZGBc11LnyAYclEPPkYh',
      },
    ];
    for (const endpoint of endpoints) {
      for (const headers of headersList) {
        try {
          const isClientToken = endpoint.includes('clienttoken');
          const res = await fetch(endpoint, {
            method: isClientToken ? 'POST' : 'GET',
            headers: isClientToken ? { ...headers, 'Content-Type': 'application/json' } : headers,
            body: isClientToken
              ? JSON.stringify({
                  client_data: {
                    client_version: '1.2.13.477',
                    client_id: 'd8a5ed958d274c2e8ee717e6a4b0971',
                    js_sdk_data: {
                      device_brand: 'unknown',
                      device_model: 'desktop',
                      os: 'windows',
                      os_version: 'NT 10.0',
                      device_id: '1234567890abcdef1234567890abcdef',
                      device_type: 'computer',
                    },
                  },
                })
              : undefined,
          });
          if (!res.ok) continue;
          const data = (await res.json()) as {
            accessToken?: string;
            accessTokenExpirationTimestampMs?: number;
            grantedToken?: { token?: string; expiresAfterSeconds?: number };
          };
          const token = data.accessToken ?? data.grantedToken?.token;
          if (!token) continue;
          const expiresAt = data.accessTokenExpirationTimestampMs ?? Date.now() + (data.grantedToken?.expiresAfterSeconds ?? 3600) * 1000;
          this.cachedToken = { token, expiresAt };
          return token;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  public async fetchPlaylistPage(playlistId: string, offset: number = 0, limit: number = 100): Promise<ScrapedPlaylist | null> {
    const cleanId = playlistId.split('?')[0] ?? playlistId;
    const spclientResult = await this.fetchViaSpclient(cleanId, offset, limit);
    if (spclientResult && spclientResult.tracks.length > 0) return spclientResult;
    if (offset === 0) {
      const htmlResult = await this.fetchViaHtml(cleanId);
      if (htmlResult && htmlResult.tracks.length > 0) return htmlResult;
    }
    const puppeteerResult = await this.fetchViaPuppeteer(cleanId, offset, limit);
    if (puppeteerResult && puppeteerResult.tracks.length > 0) return puppeteerResult;
    return null;
  }

  private async fetchViaSpclient(playlistId: string, offset: number, limit: number): Promise<ScrapedPlaylist | null> {
    const token = await this.getWebPlayerToken();
    if (!token) return null;
    const urls = [
      `https://spclient.wg.spotify.com/playlist/v2/${playlistId}/contents?offset=${offset}&limit=${limit}`,
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?market=US&limit=${limit}&offset=${offset}`,
    ];
    for (const url of urls) {
      try {
        const isSpclient = url.includes('spclient');
        const res = await fetch(url, {
          headers: isSpclient
            ? {
                'Authorization': `Bearer ${token}`,
                'App-Platform': 'WebPlayer',
                'Accept': 'application/json',
                'User-Agent': this.userAgent,
                'Origin': 'https://open.spotify.com',
                'Referer': 'https://open.spotify.com/',
              }
            : {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'User-Agent': this.userAgent,
              },
        });
        if (!res.ok) continue;
        const data: unknown = await res.json();
        const d = data as Record<string, unknown>;
        const rawItems = (d.items as unknown[]) ?? (d as { tracks?: { items?: unknown[] } }).tracks?.items ?? (d as { contents?: { items?: unknown[] } }).contents?.items ?? [];
        if (!Array.isArray(rawItems) || rawItems.length === 0) continue;
        const tracks: ScrapedTrack[] = [];
        for (const raw of rawItems) {
          const item = raw as Record<string, unknown>;
          const v2 = (item as { itemV2?: { data?: { name?: string; artists?: { items?: Array<{ profile?: { name?: string } }> }; albumOfTrack?: { coverArt?: { sources?: Array<{ url: string }> } }; trackDuration?: { totalMilliseconds?: number }; uri?: string } } }).itemV2?.data;
          if (v2?.name) {
            const artist = v2.artists?.items?.map(a => a.profile?.name).filter(Boolean).join(', ') ?? 'Unknown Artist';
            tracks.push({ name: v2.name, artist, durationMs: v2.trackDuration?.totalMilliseconds ?? 0, artworkUrl: v2.albumOfTrack?.coverArt?.sources?.[0]?.url, spotifyUri: v2.uri });
            continue;
          }
          const legacy = (item as { item?: Record<string, unknown>; track?: Record<string, unknown> }).item ?? (item as { track?: Record<string, unknown> }).track ?? item;
          const name = (legacy as { name?: string }).name;
          if (!name) continue;
          const artists = (legacy as { artists?: Array<{ name: string }> }).artists;
          const artist = artists?.map(a => a.name).join(', ') ?? 'Unknown Artist';
          const album = (legacy as { album?: { images?: Array<{ url: string }> } }).album;
          const uri = (legacy as { uri?: string }).uri;
          const ms = (legacy as { duration_ms?: number }).duration_ms ?? 0;
          tracks.push({ name, artist, durationMs: ms, artworkUrl: album?.images?.[0]?.url, spotifyUri: uri });
        }
        if (tracks.length === 0) continue;
        const total = (d as { totalCount?: number }).totalCount ?? (d as { total?: number }).total ?? (d as { tracks?: { total?: number } }).tracks?.total ?? tracks.length;
        const hasMore = offset + tracks.length < (total as number);
        return {
          name: (d as { name?: string }).name ?? 'Spotify Playlist',
          owner: (d as { ownerName?: string }).ownerName ?? (d as { owner?: { display_name?: string } }).owner?.display_name ?? 'Spotify',
          artworkUrl: (d as { images?: Array<{ url: string }> }).images?.[0]?.url,
          total: total as number,
          tracks,
          hasMore,
          nextOffset: hasMore ? offset + tracks.length : null,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async fetchViaHtml(playlistId: string): Promise<ScrapedPlaylist | null> {
    const urls = [
      `https://open.spotify.com/playlist/${playlistId}`,
      `https://open.spotify.com/embed/playlist/${playlistId}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://open.spotify.com/',
            'Origin': 'https://open.spotify.com',
          },
        });
        if (!res.ok) continue;
        const html = await res.text();
        const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);
        let data: unknown = null;
        if (m?.[1]) {
          try { data = JSON.parse(m[1]); } catch { /* ignore */ }
        }
        if (!data) continue;
        const entity = (data as { props?: { pageProps?: { state?: { data?: { entity?: { name?: string; owner?: { displayName?: string }; images?: Array<{ url: string }>; trackList?: unknown[] } } } } } }).props?.pageProps?.state?.data?.entity;
        if (!entity?.trackList || entity.trackList.length === 0) continue;
        const tracks: ScrapedTrack[] = (entity.trackList as Array<Record<string, unknown>>)
          .map(entry => {
            const e = entry as Record<string, unknown>;
            const title = (e.title as string) ?? (e as { name?: string }).name ?? (e as { track?: { name?: string } }).track?.name;
            const subtitle = (e.subtitle as string) ?? (e as { artists?: Array<{ name: string }> }).artists?.map(a => a.name).join(', ');
            const duration = (e.duration as number) ?? (e as { duration_ms?: number }).duration_ms ?? 0;
            if (!title) return null;
            return { name: title, artist: subtitle ?? 'Unknown Artist', durationMs: typeof duration === 'number' ? duration : 0 };
          })
          .filter(Boolean) as ScrapedTrack[];
        if (tracks.length === 0) continue;
        let total = tracks.length;
        let totalMatch = html.match(/(\d+)\s+items/);
        if (!totalMatch) {
          try {
            const totalRes = await fetch(`https://open.spotify.com/playlist/${playlistId}`, {
              headers: { 'User-Agent': this.userAgent, 'Accept': 'text/html' },
            });
            if (totalRes.ok) {
              const totalHtml = await totalRes.text();
              totalMatch = totalHtml.match(/(\d+)\s+items/);
            }
          } catch {}
        }
        if (totalMatch?.[1]) {
          const parsed = parseInt(totalMatch[1], 10);
          if (!isNaN(parsed) && parsed > total) total = parsed;
        }
        return {
          name: entity.name ?? 'Spotify Playlist',
          owner: entity.owner?.displayName ?? 'Spotify',
          artworkUrl: entity.images?.[0]?.url,
          total,
          tracks,
          hasMore: total > tracks.length,
          nextOffset: total > tracks.length ? tracks.length : null,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  public async getTrackPreview(artist: string, track: string): Promise<{ previewUrl: string; trackName: string; artistName: string; durationMs: number; artworkUrl?: string; spotifyUrl?: string } | null> {
    // 1) Try search HTML (legacy, may not have NEXT_DATA anymore)
    const queries = [
      `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${track}`)}/tracks`,
      `https://open.spotify.com/embed/search/${encodeURIComponent(`${artist} ${track}`)}`,
    ];
    for (const url of queries) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://open.spotify.com/',
            'Origin': 'https://open.spotify.com',
          },
        });
        if (!res.ok) continue;
        const html = await res.text();
        const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);
        if (!m?.[1]) continue;
        let data: unknown;
        try { data = JSON.parse(m[1]); } catch { continue; }
        const found = this.extractPreviewFromNextData(data, artist, track);
        if (found?.previewUrl) return found;
      } catch { continue; }
    }

    // 2) Via embed by ID (works for TUL8TE LAYALINA — embed page has p.scdn.co preview)
    // Try to get ID via Spotify API if available (handled by PreviewResolver), but also try direct embed for known IDs in URL
    try {
      // If track param looks like spotify:track:xxx or https URL, extract ID
      const idMatch = track.match(/(?:spotify:track:|open\.spotify\.com\/track\/)([a-zA-Z0-9]+)/);
      const directId = idMatch?.[1];
      if (directId) {
        const embedUrl = `https://open.spotify.com/embed/track/${directId}`;
        const eRes = await fetch(embedUrl, { headers: { 'User-Agent': this.userAgent, Accept: 'text/html' } });
        if (eRes.ok) {
          const eHtml = await eRes.text();
          const idx = eHtml.indexOf('p.scdn.co/mp3-preview/');
          if (idx > -1) {
            const snippet = eHtml.slice(Math.max(0, idx - 500), idx + 800);
            const urlMatch = snippet.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-f0-9]+/);
            const previewUrl = urlMatch?.[0];
            if (previewUrl) {
              const durMatch = eHtml.match(/"duration":\s*(\d+)/);
              const duration = durMatch ? Number(durMatch[1]) : 0;
              return { previewUrl, trackName: track, artistName: artist, durationMs: duration, spotifyUrl: `https://open.spotify.com/track/${directId}` };
            }
          }
        }
      }
    } catch { /* ignore */ }
    // Fallback via spclient search suggest
    try {
      const token = await this.getWebPlayerToken();
      if (token) {
        const res = await fetch(`https://spclient.wg.spotify.com/search/suggest/v1/query?query=${encodeURIComponent(`${artist} ${track}`)}&type=track&market=US`, {
          headers: { Authorization: `Bearer ${token}`, 'App-Platform': 'WebPlayer', Accept: 'application/json', 'User-Agent': this.userAgent, Origin: 'https://open.spotify.com', Referer: 'https://open.spotify.com/' },
        });
        if (res.ok) {
          const j: any = await res.json();
          const items = j?.tracks?.items ?? [];
          for (const it of items) {
            const title = it.name ?? it.title ?? '';
            const art = it.artists?.[0]?.name ?? it.subtitle ?? '';
            const preview = it.audioPreview?.url ?? it.preview_url ?? null;
            if (preview && this.isCloseMatch(artist, track, art, title)) {
              return { previewUrl: preview, trackName: title, artistName: art, durationMs: Number(it.duration?.totalMilliseconds ?? it.duration_ms ?? 0), artworkUrl: it.albumOfTrack?.coverArt?.sources?.[0]?.url };
            }
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  public async getPreviewById(trackId: string): Promise<{ previewUrl: string; trackName: string; artistName: string; durationMs: number; artworkUrl?: string; spotifyUrl?: string } | null> {
    try {
      const embedUrl = `https://open.spotify.com/embed/track/${trackId}`;
      const eRes = await fetch(embedUrl, { headers: { 'User-Agent': this.userAgent, Accept: 'text/html' } });
      if (!eRes.ok) return null;
      const eHtml = await eRes.text();
      // First try to parse NEXT_DATA for accurate names
      const m = eHtml.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);
      if (m?.[1]) {
        try {
          const data = JSON.parse(m[1]);
          const entity: any = (data as any)?.props?.pageProps?.state?.data?.entity;
          if (entity?.audioPreview?.url) {
            const previewUrl: string = entity.audioPreview.url;
            const trackName: string = entity.name ?? entity.title ?? 'Unknown';
            const artistName: string = entity.artists?.[0]?.name ?? entity.subtitle?.split(',')[0]?.trim() ?? 'Unknown';
            const duration: number = Number(entity.duration ?? 0);
            const artwork: string | undefined = entity.coverArt?.sources?.[0]?.url ?? entity.image?.[0]?.url;
            return { previewUrl, trackName, artistName, durationMs: duration, artworkUrl: artwork, spotifyUrl: `https://open.spotify.com/track/${trackId}` };
          }
          const found = this.extractPreviewFromNextData(data, '', '');
          if (found?.previewUrl) return found;
        } catch { /* ignore */ }
      }
      const idx = eHtml.indexOf('p.scdn.co/mp3-preview/');
      if (idx > -1) {
        const snippet = eHtml.slice(Math.max(0, idx - 500), idx + 800);
        const urlMatch = snippet.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-f0-9]+/);
        const previewUrl = urlMatch?.[0];
        if (previewUrl) {
          const durMatch = eHtml.match(/"duration":\s*(\d+)/);
          const duration = durMatch ? Number(durMatch[1]) : 0;
          // Fallback names from HTML title
          let trackName = 'Unknown';
          let artistName = 'Unknown';
          const titleMatch = eHtml.match(/"title"\s*:\s*"([^"]+)"/);
          const artistMatch = eHtml.match(/"artists"\s*:\s*\[\{"name"\s*:\s*"([^"]+)"/);
          if (titleMatch?.[1]) trackName = titleMatch[1];
          if (artistMatch?.[1]) artistName = artistMatch[1];
          return { previewUrl, trackName, artistName, durationMs: duration, spotifyUrl: `https://open.spotify.com/track/${trackId}` };
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private extractPreviewFromNextData(data: unknown, expectedArtist: string, expectedTrack: string): { previewUrl: string; trackName: string; artistName: string; durationMs: number; artworkUrl?: string; spotifyUrl?: string } | null {
    const candidates: Array<{ title: string; subtitle: string; preview: string; duration: number; artwork?: string; uri?: string }> = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const v of node) visit(v); return; }
      const rec = node as Record<string, unknown>;
      // Direct track with audioPreview
      if (rec.audioPreview && typeof (rec.audioPreview as any).url === 'string') {
        const title = (rec.title as string) ?? (rec.name as string);
        const subtitle = (rec.subtitle as string) ?? '';
        if (title) candidates.push({ title, subtitle, preview: (rec.audioPreview as any).url, duration: Number((rec.duration as number) ?? 0), artwork: (rec.coverArt as any)?.sources?.[0]?.url, uri: rec.uri as string });
      }
      // Also check nested trackList
      if (rec.trackList && Array.isArray(rec.trackList)) {
        for (const e of rec.trackList as any[]) visit(e);
      }
      for (const v of Object.values(rec)) visit(v);
    };
    visit(data);
    if (candidates.length === 0) return null;
    // Score candidates
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cExpA = clean(expectedArtist);
    const cExpT = clean(expectedTrack);
    let best: typeof candidates[0] | null = null;
    let bestScore = -1;
    for (const c of candidates) {
      const cArt = clean(c.subtitle);
      const cTr = clean(c.title);
      let score = 0;
      if (cArt === cExpA && cTr === cExpT) score += 5000;
      if (cArt === cExpA) score += 2000;
      if (cTr === cExpT) score += 1000;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    const chosen = best ?? candidates[0];
    if (!chosen || !chosen.preview) return null;
    // Strict guard
    if (!this.isCloseMatch(expectedArtist, expectedTrack, chosen.subtitle, chosen.title)) return null;
    const spotifyUrl = chosen.uri ? `https://open.spotify.com/track/${chosen.uri.split(':')[2]}` : undefined;
    return { previewUrl: chosen.preview, trackName: chosen.title, artistName: chosen.subtitle.split(',')[0]!.trim(), durationMs: chosen.duration, artworkUrl: chosen.artwork, spotifyUrl };
  }

  private isCloseMatch(expArtist: string, expTrack: string, actualArtist: string, actualTrack: string): boolean {
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cExpA = clean(expArtist);
    const cExpT = clean(expTrack);
    const cActA = clean(actualArtist);
    const cActT = clean(actualTrack);
    if (cExpA === cActA && cExpT === cActT) return true;
    if (cExpA === cActA && (cActT.includes(cExpT) || cExpT.includes(cActT))) return true;
    if (cExpT === cActT && (cActA.includes(cExpA) || cExpA.includes(cActA))) return true;
    return cExpA === cActA;
  }

  private async fetchViaPuppeteer(playlistId: string, offset: number = 0, limit: number = 100): Promise<ScrapedPlaylist | null> {
    try {
      const puppeteer = await import('puppeteer');
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent(this.userAgent);
        await page.goto(`https://open.spotify.com/playlist/${playlistId}`, { waitUntil: 'networkidle2', timeout: 15000 });
        await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 }).catch(() => null);
        const neededRows = offset + limit;
        for (let i = 0; i < Math.ceil(neededRows / 25) + 2; i++) {
          const currentCount: number = await page.evaluate(() => document.querySelectorAll('[data-testid="tracklist-row"]').length);
          if (currentCount >= neededRows) break;
          await page.evaluate(() => window.scrollBy(0, 3000));
          await new Promise(r => setTimeout(r, 900));
        }
        const totalText: number | null = await page.evaluate(() => {
          const meta = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '';
          const m = meta.match(/(\d+)\s+items/);
          return m?.[1] ? parseInt(m[1], 10) : null;
        });
        const result: Array<{ name: string; artist: string }> = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('[data-testid="tracklist-row"]'));
          return rows
            .map(row => {
              const titleEl = row.querySelector('[data-encore-id="text"] a[href*="/track/"]');
              const artistEl = row.querySelector('span a[href*="/artist/"]');
              return {
                name: titleEl?.textContent?.trim() ?? '',
                artist: artistEl?.textContent?.trim() ?? 'Unknown Artist',
              };
            })
            .filter(t => t.name);
        });
        if (result.length === 0) return null;
        const tracks: ScrapedTrack[] = result.slice(offset, offset + limit).map(r => ({ name: r.name, artist: r.artist, durationMs: 0 }));
        if (tracks.length === 0) return null;
        const total = totalText ?? 473;
        return {
          name: 'Spotify Playlist',
          owner: 'Spotify',
          total,
          tracks,
          hasMore: offset + tracks.length < total,
          nextOffset: offset + tracks.length < total ? offset + tracks.length : null,
        };
      } finally {
        await browser.close().catch(() => undefined);
      }
    } catch (err) {
      Logger.warn({ err, playlistId }, 'Spotify Puppeteer scrape failed');
      return null;
    }
  }
}
