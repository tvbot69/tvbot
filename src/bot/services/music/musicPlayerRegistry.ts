import type { Player } from 'moonlink.js';
import type { FilterName } from '@domain/models/music/musicQueue';
import { resolverEnabled } from './ytResolver';
import { HOME_NODE } from './youtubeHealth';
import { isNodeCooling } from './musicNodeHealth';
import type { MoonlinkManager } from './moonlinkManager';
import type { QueueService } from './queueService';

/**
 * Custom definitions for our FilterNames that Moonlink does NOT ship
 * built in (it only has nightcore/vaporwave/karaoke of ours — the rest
 * throw `Filter does not exist` on enable). Registered per player via
 * ensureFilterDefined before every enable, so toggles, restores, and
 * interaction retries all work. Values are standard audible Lavalink
 * shapes; distortion starts mild — ear-test before pushing further.
 */
export const FILTER_DEFINITIONS: Partial<Record<FilterName, Record<string, unknown>>> = {
  bassboost: {
    equalizer: [
      { band: 0, gain: 0.6 }, { band: 1, gain: 0.5 }, { band: 2, gain: 0.4 },
      { band: 3, gain: 0.2 }, { band: 4, gain: 0 }, { band: 5, gain: 0 },
      { band: 6, gain: 0 }, { band: 7, gain: 0 }, { band: 8, gain: 0 },
      { band: 9, gain: 0 }, { band: 10, gain: 0 }, { band: 11, gain: 0 },
      { band: 12, gain: 0 }, { band: 13, gain: 0 }, { band: 14, gain: 0 },
    ],
  },
  // Studio clarity via SUBTRACTION: cut mud and harshness, leave everything
  // else flat. Deliberately almost no boosts — boosts on small drivers +
  // low-bitrate streams clip and distort (v1 boosted the lows and sounded
  // like a muddy bassboost). Cuts can't clip; nudge volume up to compensate.
  audiophile: {
    equalizer: [
      { band: 0, gain: 0 }, { band: 1, gain: 0 }, { band: 2, gain: 0 },
      { band: 3, gain: 0 }, { band: 4, gain: -0.05 }, { band: 5, gain: -0.15 },
      { band: 6, gain: -0.05 }, { band: 7, gain: 0 }, { band: 8, gain: 0 },
      { band: 9, gain: 0 }, { band: 10, gain: -0.15 }, { band: 11, gain: -0.1 },
      { band: 12, gain: 0 }, { band: 13, gain: 0.1 }, { band: 14, gain: 0 },
    ],
  },
  tremolo: { tremolo: { frequency: 2.0, depth: 0.5 } },
  vibrato: { vibrato: { frequency: 4.0, depth: 0.5 } },
  rotation: { rotation: { rotationHz: 0.2 } },
  distortion: {
    distortion: {
      sinOffset: 0, sinScale: 1.5, cosOffset: 0, cosScale: 0.8,
      tanOffset: 0, tanScale: 0.5, offset: 0, scale: 1,
    },
  },
  lowpass: { lowPass: { smoothing: 20.0 } },
};

/**
 * Equalizer presets are mutually exclusive: Moonlink CONCATENATES the band
 * arrays of every active EQ filter (30 entries for two presets), which
 * Lavalink resolves unpredictably — in practice, mud. Enabling one EQ
 * preset silently switches the other off. All other DSP blocks combine
 * cleanly and stay stackable.
 */
export const EQ_EXCLUSIVE_GROUP: FilterName[] = ['bassboost', 'audiophile'];

/** Registers our custom definition on the player (idempotent, silent). */
export const ensureFilterDefinedOn = (player: Player, filter: FilterName): void => {
  const def = FILTER_DEFINITIONS[filter];
  if (def === undefined) return;
  try {
    player.filters.define(filter, def as never);
  } catch {
    // Already defined or client without custom support — enable decides.
  }
};

/**
 * A destroyed player stays in moonlink's map until its REST teardown
 * finishes (hundreds of ms to seconds). Handing that corpse out invites the
 * worst failure in this module: a `stop()` during an in-flight ladder search
 * would let the search land afterwards, `queue.add` onto the dead player and
 * `play()` reconnect the bot to voice — with the map entry deleted a moment
 * later, so nothing owned the connection and the bot sat in a channel muted
 * until someone manually disconnected it.
 */
export const isDestroyedPlayer = (player: Player | undefined | null): boolean =>
  !!player && (player as unknown as { destroyed?: boolean }).destroyed === true;

/**
 * Player acquisition and creation: hands out live players only, and builds a
 * fresh one with its persisted guild preferences already applied.
 *
 * Extracted from MusicService. Holds no state of its own — every player lives
 * in `MoonlinkManager`, so the registry is a view over the manager rather than
 * a second source of truth.
 */
export class PlayerRegistry {
  public constructor(
    private readonly moonlinkManager: MoonlinkManager,
    private readonly queueService: QueueService,
  ) {}

  public getPlayer(guildId: string): Player | undefined {
    const player = this.moonlinkManager.getManager().players.get(guildId);
    return isDestroyedPlayer(player) ? undefined : player;
  }

  /** Registers our custom definition on the player (idempotent, silent). */
  public ensureFilterDefined(player: Player, filter: FilterName): void {
    ensureFilterDefinedOn(player, filter);
  }

  public async getOrCreatePlayer(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Promise<Player> {
    const manager = this.moonlinkManager.getManager();
    let player = manager.players.get(guildId);
    let created = false;
    if (isDestroyedPlayer(player)) {
      // Still mapped, already dead: players.create() hands the corpse back, so
      // evict it first or the guild is stuck with an unplayable player until
      // moonlink's own teardown lands.
      try {
        (manager.players as unknown as { delete: (id: string) => unknown }).delete(guildId);
      } catch {
        // Older shapes expose a Map; fall through and let create() decide.
      }
      player = undefined;
    }
    if (!player) {
      // Re-apply persisted guild prefs so a recreate (rejoin, failover,
      // restart) doesn't reset volume/loop/autoplay/filters.
      const prefs = this.queueService.getSettings(guildId);
      player = manager.players.create({
        guildId,
        voiceChannelId,
        textChannelId,
        autoPlay: prefs.autoplay,
        volume: prefs.volume,
        selfDeaf: true,
      });
      if (prefs.loopMode !== 'off') {
        try {
          player.setLoop(prefs.loopMode as 'track' | 'queue');
        } catch {
          // ignore invalid stored loop values
        }
      }
      if (prefs.filters.length > 0) {
        // Sanitize: settings saved while EQ presets could stack may hold
        // both bassboost and audiophile — keep the most recent (last).
        const eqSeen = new Set<FilterName>();
        const sanitized = [...prefs.filters].reverse().filter((f) => {
          if ((EQ_EXCLUSIVE_GROUP as string[]).includes(f)) {
            if (eqSeen.size > 0) return false;
            eqSeen.add(f as FilterName);
          }
          return true;
        }).reverse();
        for (const filter of sanitized) {
          try {
            this.ensureFilterDefined(player, filter as FilterName);
            player.filters.enable(filter as Parameters<typeof player.filters.enable>[0]);
          } catch {
            // ignore unknown filter names
          }
        }
        void player.filters.apply().catch(() => undefined);
      }
      created = true;
    }

    // Fresh players start on Home when the resolver is configured: local
    // files only exist there, and Home-first is the standing preference.
    // Existing (playing) players are never moved here — failover owns that.
    // A REST-dead Home is never pinned: the least-load pick stands and
    // search-level exclusions route around it.
    if (created && resolverEnabled() && !isNodeCooling(this.moonlinkManager, HOME_NODE)) {
      try {
        await player.transferNode(HOME_NODE).catch(() => undefined);
      } catch {
        // Home down or missing — least-load pick stands
      }
    }

    if (isDestroyedPlayer(player)) {
      throw new Error('player-destroyed');
    }

    // setVoiceChannelId is a LOCAL assignment — it does not move the Discord
    // connection. Retargeting it while connected made the bot's own bookkeeping
    // lie: the empty-channel timer read the CALLER's channel (so any member
    // could trigger a pause + destroy from an empty one) while audio kept
    // playing where the bot actually was. Only sync it when we are not live.
    if (player.voiceChannelId !== voiceChannelId && !player.connected) {
      player.setVoiceChannelId(voiceChannelId);
    }
    if (player.textChannelId !== textChannelId) {
      player.setTextChannelId(textChannelId);
    }

    return player;
  }
}
