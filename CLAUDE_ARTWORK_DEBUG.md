# Handoff: tvbot playlist-track artwork gaps (for Claude)

> Moha pastes this file to you as full context. The repo is
> `github.com/tvbot69/tvbot`, branch `main`. The general music context lives
> in `CLAUDE_HANDOFF.md` (§1–§8) — read that first if you haven't. This file
> is ONLY about one bug: **some playlist tracks play with no embed artwork**.
> Correct me where I'm wrong. Do not propose loosening match thresholds
> without saying what wrong-art cases it would admit.

## 0. State of the world

- HEAD as of writing: `6e47a52` (see §5 for the fix trail).
- Suite: 91 files / 577 tests green, `npm run build` green.
- The bot runs on Railway (deploys lag pushes by minutes — always confirm the
  live SHA before concluding a fix didn't work; we have been burned twice).
- The home PC (Windows 10, `DESKTOP-76HQU9H`) runs self-hosted Lavalink 4.2.2
  (`Home` node, Tailscale Funnel) and a Deno yt-dlp resolver (`:8443`).

## 1. System in 60 seconds (artwork-relevant parts only)

- Playback ladder on Home is **resolver-first**: `ytsearch` (metadata always
  works) → yt-dlp materializes the video id to `C:\ytres\cache\Title [id].webm`
  → Lavalink `loadTracks(path)` → play. Plugin YouTube audio is 100% walled
  (login/cipher), so the plugin rung on Home is flag-gated off.
- **Resolver files are artless.** `loadTracks` on a local file yields
  `Unknown title`, no artwork. All display metadata is adopted bot-side.
- Spotify playlists resolve via `MusicService.playSpotify`: track 1
  immediately, tracks 2+ as **pending entries** resolved 2-ahead by
  `topUpPending` on trackStart/trackEnd/queueEnd.
- `adoptSpotifyTrack` stamps `title/author/artworkUrl/uri` from the Spotify
  data onto the raw Lavalink track. If the Spotify data has no art, the raw
  track's art (YouTube thumb, or nothing for local files) is all there is.
- `mapMoonlinkTrack` (src/domain/models/music/musicTrack.ts) picks
  `rawTrack.artworkUrl || track.artworkUrl || track.thumbnail`; builders
  (`musicBuilders.buildNowPlayingResponse`) render a thumbnail/gallery **iff**
  `artworkUrl` is present. Nothing downstream invents art.
- Golden rule: covers always resolve through `ArtworkService`
  (Spotify → Deezer → Apple web → iTunes → Last.fm→album, strict
  artist+title matching, memory cache). Never Last.fm `imageUrl` directly.

## 2. The bug

Playing a Spotify playlist: music plays correctly (JIT verified), but SOME
tracks' Now Playing embeds have no artwork. Single-track plays show art
normally. Example raw card (Components V2 container, text + buttons, **no
media gallery / thumbnail accessory at all**):

- Track `GONE 4 A MIN` by `Yeat`, source badge YouTube, from
  `open.spotify.com/playlist/73VZK7BqgCVuZr5Z3rv40k` (242 tracks).
- Live log at play time:
  `[Music] Resolver hit { id: '6RV8yS5AOqA', resolveMs: 681, cached: true }`
  then `Track started ... "GONE 4 A MIN" by "Yeat"`.
  NO `Artwork backfilled` / `backfill miss` line for it — while the NEXT
  track logged `Artwork backfilled { title: 'Lights Out', ... resolveMs: 0 }`.
  (That asymmetry located the first-track bug in §5.)

## 3. Proven facts (all verified, not guessed)

1. That exact playlist resolves with **zero per-track art**. Local probe of
   `spotifyResolver.resolve(playlistUrl)`: `type=playlist total=242 got=100`,
   sampled tracks (`GONE 4 A MIN`, `Lights Out`, `NEEDIT`) all `art=NO`.
2. The cascade **has** the missing cover. Local probe of
   `getTrackCoverUrl('GONE 4 A MIN', 'Yeat')` returned
   `https://i.scdn.co/image/ab67616d0000b273…` (Spotify CDN, first provider).
   So lookup-by-name works for this track; the gap was upstream of it.
3. The backfill is live and fires: `Artwork backfilled { Lights Out }`.
4. The old negative cache poisoned everything: ANY miss (throw,
   rate-limit, timeout) was cached as `'none'` for 3600s. Fixed (§5).
5. Timeouts were beheading slow hits: single 6s guard everywhere. Now tiered
   (6s user-waiting, 10s background).

## 4. Rung → raw-art matrix (why playlists are exposed and singles aren't)

| Rung | Raw track art | Art source on embed |
|---|---|---|
| plugin (YouTube hit) | YouTube thumb (mq/hqdefault) | Shows (low-res) even with no Spotify art |
| resolver (local file) | NONE | Spotify data or backfill or nothing |
| soundcloud | SC thumbnail | Shows |

Singles usually land plugin (thumb present) → "normal tracks show art".
Playlists on Home land resolver (artless) → depend entirely on Spotify-data
art + backfill. That is the whole asymmetry.

## 5. Fix trail (all on main)

- `2c14f16` — resolve-time backfill `maybeBackfillArt` (skip when raw or
  Spotify art present; 6s race; catch-all).
- `3cb07db` — the first-track path called `searchTrackWithLadder` directly
  and skipped backfill (the §2 log asymmetry); fixed + regression test
  proven to fail without it.
- `8141016` — negative cache only for DEFINITIVE misses (all providers
  answered no), 10-min TTL; throws/rate-limits never cached; + art warmup
  (next 3 pending entries, deduped, timeout-guarded, silent).
- `6e47a52` — tiered timeouts: 6s where a user waits (single, first track),
  10s in background (`resolvePlaylistTrack`, warmup).

## 6. The code (exact, current main)

### 6a. `getTrackCoverUrl` — src/bot/services/artworkService.ts:514-635 (full)

```ts
public async getTrackCoverUrl(trackName?: string, artistName?: string): Promise<string | null> {
  if (!trackName || !artistName) return null;
  const cleanTrack = sanitizeMusicName(trackName);
  const key = `art:track:${artistName.toLowerCase()}|${cleanTrack.toLowerCase()}`;

  const cached = await this.cache.get<string>(key);
  if (cached) {
    if (cached === 'none') return null;
    if (isPlaceholderImageUrl(cached)) return null;
    return cached;
  }

  let result: string | null = null;
  const attempts: ProviderAttempt[] = [];

  // Every provider below must match BOTH artist and title. First-result
  // trust is what produced wrong covers (same-title recordings, covers,
  // remixes by other artists) — a miss falls through to the next provider.
  const trackMatches = (
    candidateArtist: string | undefined,
    candidateTitle: string | undefined,
  ): boolean =>
    matchesArtistName(candidateArtist ?? '', artistName) &&
    matchesTrackTitle(candidateTitle ?? '', cleanTrack);

  if (SpotifySearchApi.isRateLimited()) {
    attempts.push({ source: 'spotify:rate-limited' });
  }
  if (!SpotifySearchApi.isRateLimited()) {
    try {
      let tracks = await this.spotifyApi.searchTracks(
        `track:${cleanTrack} artist:${artistName}`,
      );
      if (tracks.length === 0) {
        tracks = await this.spotifyApi.searchTracks(`${cleanTrack} ${artistName}`);
      }
      const match = tracks.find((t) =>
        (t.artists ?? []).some((a) => matchesArtistName(a.name, artistName)) &&
        matchesTrackTitle(t.name, cleanTrack),
      );
      const url = pickLargest(match?.album?.images);
      if (url) {
        result = url;
        const artistRow = await this.artistRepository.getArtistByName(artistName);
        if (artistRow) {
          const trackRow = await this.trackRepository.getTrackByNameAndArtist(
            cleanTrack,
            artistRow.artistId,
          );
          if (trackRow) {
            await this.trackRepository.setSpotifyImage(trackRow.trackId, url, new Date());
          }
        }
      }
    } catch (err) {
      attempts.push({ source: 'spotify' });
      Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: spotify miss');
    }
  }

  if (!result) {
    try {
      let tracks = await this.deezerApi.searchTracks(`${cleanTrack} ${artistName}`);
      if (tracks.length === 0) {
        tracks = await this.deezerApi.searchTracks(`${artistName} ${cleanTrack}`);
      }
      const match = tracks.find((t) => trackMatches(t.artist?.name, t.title));
      result = match?.album?.cover_xl ?? match?.album?.cover_big ?? null;
    } catch (err) {
      attempts.push({ source: 'deezer' });
      Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: deezer miss');
    }
  }

  if (!result) {
    try {
      const songs = await this.appleMusicWebApi.searchSongs(cleanTrack, artistName);
      const match = songs.find((s) => trackMatches(s.artistName, s.name));
      result = match?.artwork?.url ?? null;
    } catch (err) {
      attempts.push({ source: 'am-web' });
      Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: am-web miss');
    }
  }

  if (!result) {
    try {
      const songs = await this.appleMusicApi.searchSongs(cleanTrack, artistName);
      const match = songs.find(
        (s) => s.artworkUrl100 && trackMatches(s.artistName, s.trackName),
      );
      if (match?.artworkUrl100) {
        const upscaled = upscaleArtwork(match.artworkUrl100);
        if (isValidImageUrl(upscaled)) result = upscaled;
      }
    } catch (err) {
      attempts.push({ source: 'itunes' });
      Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: itunes miss');
    }
  }

  if (!result) {
    try {
      const info = await this.lastfmRepository.getTrackInfo(trackName, artistName);
      if (info?.albumName) {
        result = await this.getAlbumCoverUrl(info.albumName, artistName);
      }
    } catch (err) {
      attempts.push({ source: 'lastfm' });
      Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: lastfm miss');
    }
  }

  if (result && isPlaceholderImageUrl(result)) result = null;
  if (result) {
    await this.cache.set(key, result, MEMORY_CACHE_TTL_SECONDS /* 3600 */);
  } else if (attempts.length === 0) {
    // Definitive miss only — see NONE_TTL_SECONDS (600).
    await this.cache.set(key, 'none', NONE_TTL_SECONDS);
  }
  return result;
}
```

Notes for you: legs run SEQUENTIALLY (Spotify 2 searches → Deezer 2 →
AppleWeb 1 → iTunes 1 → Last.fm trackInfo → album cascade). No per-leg
timeouts inside; providers use `fetchWithTimeout` individually (see
src/spotify/api/spotifySearchApi.ts etc.). `sanitizeMusicName`,
`matchesArtistName`, `matchesTrackTitle`, `pickLargest`, `upscaleArtwork`
are module-local in artworkService.ts. `SpotifySearchApi.isRateLimited()` /
`clearRateLimit()` are static (same file family).

### 6b. `maybeBackfillArt` — src/bot/services/music/musicService.ts:643-685 (full)

```ts
private async maybeBackfillArt(
  track: Track,
  knownArtworkUrl?: string,
  title?: string,
  artist?: string,
  timeoutMs: number = MusicService.ARTWORK_TIMEOUT_MS, // 6000
): Promise<void> {
  try {
    if (!track || track.artworkUrl || knownArtworkUrl) return;
    if (!this.artworkService) {
      Logger.debug('[Music] Artwork backfill skipped — no artwork service wired');
      return;
    }
    const t = (title || track.title)?.trim();
    const a = (artist || track.author)?.trim();
    if (!t || !a) return;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const lookup = this.artworkService.getTrackCoverUrl(t, a);
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const url = await Promise.race([lookup, timeout]);
      if (url) {
        track.artworkUrl = url;
        Logger.info(
          { title: t, artist: a, resolveMs: Date.now() - started },
          '[Music] Artwork backfilled',
        );
      } else {
        Logger.debug(
          { title: t, artist: a, resolveMs: Date.now() - started },
          '[Music] Artwork backfill miss',
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    // ignore — playback without art beats no playback
  }
}
```

Call sites (musicService.ts): single-Spotify after resolve (~line 388),
YT-URL swapped (~368), text query (~513), playlist first track (~567),
`resolvePlaylistTrack` (~848, background 10s timeout). `ArtworkService` is
the optional 5th ctor param (wired in startup.ts:597 from the instance at
:340; tests pass 3 args → backfill safely no-ops).

### 6c. `warmUpcomingArt` — musicService.ts:722-748 (full)

```ts
private warmUpcomingArt(guildId: string): void {
  if (!this.artworkService) return;
  const pending = this.pendingSpotify.get(guildId);
  if (!pending || pending.length === 0) return;
  for (const entry of pending.slice(0, 3)) {
    // Entries that already carry art need no lookup — adoption sets it.
    if (entry.spTrack.artworkUrl || entry.override?.artworkUrl) continue;
    const key = `${entry.spTrack.artist} - ${entry.spTrack.name}`.toLowerCase();
    if (this.artWarmKeys.has(key)) continue;
    this.artWarmKeys.add(key);
    void (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const lookup = this.artworkService!.getTrackCoverUrl(entry.spTrack.name, entry.spTrack.artist);
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS /* 10000 */);
        });
        await Promise.race([lookup, timeout]);
      } catch {
        // ignore — resolve-time backfill remains the safety net
      } finally {
        if (timer) clearTimeout(timer);
        this.artWarmKeys.delete(key);
      }
    })();
  }
}
```

Called at the end of `topUpPending` (musicService.ts:825), which keeps 2
resolved tracks ahead of the Moonlink queue on trackStart/trackEnd/queueEnd
and adopts Spotify metadata per resolved track (`adoptSpotifyTrack`,
~line 692+; `mapPendingEntry` for reply display). Pending entries carry
`{ spTrack, requester, spotifyUrl, override }`.

### 6d. Render path (pointers, short)

- `mapMoonlinkTrack` (src/domain/models/music/musicTrack.ts:172-186):
  `artworkUrl = rawTrack.artworkUrl || track.artworkUrl || track.thumbnail`,
  plus YouTube hqdefault upgrade ONLY when mapped source is youtube
  (adopted Spotify tracks map to source `spotify`, so no upgrade applies).
- `buildNowPlayingResponse` (src/bot/builders/musicBuilders.ts:248-268):
  gallery + `setImage` iff `current.artworkUrl` present, else text-only card
  (exactly the §2 symptom).

## 7. Open questions for you

1. Tracks still miss after all of §5. The `resolveMs` on
   `[Music] Artwork backfill miss` lines distinguishes: ~6000/10000ms =
   still too slow (do we parallelize provider legs?); small numbers =
   providers genuinely lack those tracks (is there any SAFE loosening of
   `trackMatches`, or a better source?). Which does the evidence support?
2. JIT top-up resolves 2 + warms 3 per advance — up to ~5 concurrent
   cascades × providers. Does that burst pattern risk Spotify 429s that
   turn into (now-uncached, retryable, but still) misses at resolve time?
   Should warmup stagger, shrink, or check `isRateLimited()` first?
3. Anything between `queue.add` and Now Playing render that could drop an
   adopted `artworkUrl`? (Titles adopted the same way display correctly, so
   this looks airtight — but confirm.)
4. `getAlbumCoverUrl` (artworkService.ts:137+) and `getArtistImageUrl`
   (:312+) got the same definitive/inconclusive gating — check the gate
   placement, especially the lastfm-redirect recursion at old line ~469.

## 8. Answers from the second pass (implemented, main)

- **Playlist source**: `resolvePlaylist` is scraper-FIRST by design
  (spotifyResolver.ts:312, "no Spotify API, no token scope issues"), API only
  as fallback. The 100-track cap is real but tracks 101+ DO resolve — the
  chunk manager registers `nextOffset: 100` (seen live in logs). Nothing
  silently never resolves.
- **HTML scraper was art- AND uri-blind**: `fetchViaHtml` mapped only
  name/artist/duration. The embed payload carries `uri: spotify:track:…`
  per item (verified live fetch — but NO per-item images). Now mapped, which
  unlocks the by-ID path below for exactly these tracks.
- **Search limit**: `searchTracks`/`searchAlbums` defaulted to 5
  (`DEFAULT_LIMIT`). Artwork cascade now passes 10 explicitly (track +
  album legs).
- **By-ID art**: new `SpotifySearchApi.getTrack(id)` (single GET, throws on
  429/5xx/network like `search()`, credential-rotate parity) +
  `ArtworkService.getTrackCoverBySpotifyId` (spid-key cache, same
  definitive/inconclusive semantics). Backfill tries by-ID first (needs a
  Spotify URI — present on API + v2-parser + now html-parser tracks), then
  the name cascade. Warmup does the same.
- **Late attach**: the losing race promise is kept; if art lands late and
  the track is still bare, it attaches (`Artwork late-attached` log). Safe:
  the progress updater rebuilds `buildNowPlayingResponse` fresh every 15s
  edit, so late art appears without a track change.
- **Burst discipline**: warmup skips entirely while `isRateLimited()`,
  shrunk 3→2. No process-wide semaphore (yet — say if the burst math still
  worries you).
- **Adoption overwrite**: already correct (`if (spTrack.artworkUrl)` guard —
  undefined never erases the raw thumbnail). No change.
- **Blind-gate fix**: `getAlbumCoverUrl` accepts an outer attempts collector
  (inner inconclusive → `album-inner` marker, no double negative-cache);
  artist lastfm-redirect pushes `lastfm-redirect:unknown` when the inner
  outcome is opaque. All provider wrappers verified throw-on-error
  (Spotify/Deezer/Apple-web/iTunes/Last.fm paths checked) — `[]` means a
  real 200-empty.
- **Open, needs Moha's call**: video-thumbnail last resort
  (`i.ytimg.com/vi/<id>/mqdefault.jpg` when everything misses). Plugin and
  SoundCloud rungs already show thumbs; this trades blank cards for video
  thumbs on the resolver rung. Bends the golden rule — his decision.
- Watch-item (unverifiable from here): Spotify Dev Mode apps stop working
  if the owner's Premium lapses. Worth knowing on a $0 budget.
