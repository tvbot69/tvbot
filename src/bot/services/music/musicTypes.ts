import type { Player } from 'moonlink.js';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';
import type { MirrorTrack, MusicTrackRequester } from '@domain/models/music/musicTrack';

/**
 * Leaf types for the music playback module.
 *
 * This file deliberately imports NOTHING from the rest of the music module.
 * That is the whole point: every extracted collaborator depends on these
 * interfaces instead of on `MusicService`, so the dependency graph stays a
 * strict DAG with no cycles back to the composition root.
 *
 * Ports (PlayerProvider, QueueInfoProvider, PendingQueueView) are the seams
 * that let a collaborator ask for a capability without knowing who implements
 * it or being able to construct it.
 */

/**
 * Unresolved entry waiting for just-in-time resolution. The slot names are
 * historical — `spTrack`/`spotifyUrl` now carry any provider's mirror track
 * (Spotify/Deezer/Apple) and its canonical page URL.
 */
export interface PendingEntry {
  spTrack: MirrorTrack;
  requester: MusicTrackRequester;
  spotifyUrl: string;
  override?: { title?: string; author?: string; artworkUrl?: string; source?: string };
}

/**
 * Read/write access to the pending (just-in-time) queue.
 *
 * CRITICAL: implementations MUST return the live array, never a copy. Callers
 * deliberately mutate what they get back — `shuffle` reorders in place and
 * `remove` splices in place. Returning a copy silently turns both into
 * no-ops while every assertion on the returned value still passes.
 */
export interface PendingQueueView {
  get(guildId: string): PendingEntry[] | undefined;
  set(guildId: string, entries: PendingEntry[]): void;
  delete(guildId: string): void;
  has(guildId: string): boolean;
}

/** Hands out a live player, or undefined when the guild has none. */
export interface PlayerProvider {
  getPlayer(guildId: string): Player | undefined;
}

/** The single seam for the merged visible queue (resolved + pending). */
export interface QueueInfoProvider {
  getQueueInfo(guildId: string): MusicQueueInfo | null;
}

/**
 * Structural shape of the chunk manager, declared here so the pending store can
 * drive it without a value import of the concrete class (which would close a
 * cycle back to the music module).
 */
export interface ChunkManagerLike {
  bindEvents(): void;
  setTrackResolver(resolver: (player: Player, spTrack: MirrorTrack) => Promise<unknown>): void;
  clear(guildId: string): void;
}
