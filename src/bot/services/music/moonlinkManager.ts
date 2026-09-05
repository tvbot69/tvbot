import { Manager, Connectors, type Node, type Player } from 'moonlink.js';
import type { Client } from 'discord.js';
import { Logger } from '@domain/logger';
import { getLavalinkNodes, type LavalinkNodeConfig } from '@config/lavalink';
import type { CacheService } from '../cacheService';

export interface LavalinkNodeStats {
  identifier: string;
  host: string;
  port: number;
  connected: boolean;
  players: number;
  playingPlayers: number;
  cpuLoad: number;
  lavalinkLoad: number;
  memoryUsedMb: number;
  memoryAllocatedMb: number;
  uptimeMs: number;
  ping: number;
}

export class MoonlinkManager {
  private readonly manager: Manager;
  private client: Client | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isInitialized = false;
  private readonly nodeCooldownUntil = new Map<string, number>();
  private readonly nodeReconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastRateLimitLog = new Map<string, number>();
  private readonly cache: CacheService | null;
  private readonly lavalinkEnabled: boolean;

  constructor(cache?: CacheService) {
    this.cache = cache ?? null;
    // Dev no-connect: in local env, lavalink is disabled unless ENABLE_LAVALINK=true
    // This prevents thundering herd on public nodes during rapid `npm run dev` restarts
    const env = process.env.ENVIRONMENT ?? 'local';
    const flag = process.env.ENABLE_LAVALINK;
    this.lavalinkEnabled = flag === 'true' || env !== 'local';
    if (!this.lavalinkEnabled) {
      Logger.info('[Lavalink] Disabled in dev (ENVIRONMENT=local, ENABLE_LAVALINK != true) — skipping node connections. Set ENABLE_LAVALINK=true to enable music locally.');
      // Moonlink.js validates nodes array non-empty, so use a dummy that we never init()
      this.manager = new Manager({
        nodes: [{ identifier: 'dummy-disabled', host: '127.0.0.1', port: 2333, password: 'dummy', secure: false, retryAmount: 0, retryDelay: 60000 }],
        options: {
          clientName: 'tvbot/1.0.0 (Moonlink v5)',
          resume: false,
          node: { autoMovePlayers: true, avoidUnhealthyNodes: true, retryAmount: 0, retryDelay: 60000, maxCpuLoad: 0.85 },
          search: { defaultPlatform: 'youtube', resultLimit: 15 },
          voiceConnection: { timeout: 15000, autoReconnect: true },
        },
      });
      // Register events but skip health loop — no real nodes to monitor
      this.registerNodeEvents();
      return;
    }

    const nodes = getLavalinkNodes();
    Logger.info(`Configuring Moonlink.js with ${nodes.length} Lavalink nodes (master-class staggered)...`);
    void this.restoreCooldownsFromCache(nodes);

    // Master-class: public nodes hate parallel connects. Retry with backoff for 4000.
    // We keep retryAmount low and add cooldown in nodeDisconnect handler.
    this.manager = new Manager({
      nodes: nodes.map((n: LavalinkNodeConfig) => ({
        identifier: n.identifier,
        host: n.host,
        port: n.port,
        password: n.password,
        secure: n.secure ?? n.port === 443,
        retryAmount: 0,
        retryDelay: 60000,
      })),
      options: {
        clientName: 'tvbot/1.0.0 (Moonlink v5)',
        resume: false,
        node: {
          autoMovePlayers: true,
          avoidUnhealthyNodes: true,
          retryAmount: 0,
          retryDelay: 60000,
          maxCpuLoad: 0.85,
        },
        search: {
          defaultPlatform: 'youtube',
          resultLimit: 15,
        },
        voiceConnection: {
          timeout: 15000,
          autoReconnect: true,
        },
      },
    });

    this.registerNodeEvents();
    this.startHealthCheckLoop();
  }

  public getManager(): Manager {
    return this.manager;
  }

  public async init(client: Client): Promise<void> {
    if (!this.lavalinkEnabled) {
      Logger.info('[Lavalink] init skipped — lavalink disabled in dev');
      return;
    }
    if (this.isInitialized) {
      return;
    }

    this.client = client;
    this.manager.use(new Connectors.DiscordJs(), client);

    if (client.user?.id) {
      await this.manager.init(client.user.id);
      this.isInitialized = true;
      Logger.info('Moonlink.js Manager connected to Lavalink nodes successfully');
    } else {
      client.once('ready', async (readyClient) => {
        if (!this.isInitialized) {
          await this.manager.init(readyClient.user.id);
          this.isInitialized = true;
          Logger.info('Moonlink.js Manager connected to Lavalink nodes on client ready');
        }
      });
    }
  }

  private getAllNodes(): Node[] {
    if (this.manager.nodes?.nodes instanceof Map) {
      return Array.from(this.manager.nodes.nodes.values());
    }
    if (Array.isArray(this.manager.nodes?.onlineNodes)) {
      return this.manager.nodes.onlineNodes;
    }
    return [];
  }

  private isNodeInCooldown(identifier: string): boolean {
    const until = this.nodeCooldownUntil.get(identifier);
    return !!until && Date.now() < until;
  }

  private setNodeCooldown(identifier: string, ms: number): void {
    this.nodeCooldownUntil.set(identifier, Date.now() + ms);
    Logger.debug(`[Lavalink] Node "${identifier}" put on cooldown for ${ms / 1000}s`);
    // Persist across restarts so rapid `npm run dev` doesn't reset backoff
    if (this.cache) {
      void this.cache.set(`lavalink:cooldown:${identifier}`, Date.now() + ms, Math.ceil(ms / 1000)).catch(() => undefined);
    }
  }

  private async restoreCooldownsFromCache(nodes: LavalinkNodeConfig[]): Promise<void> {
    if (!this.cache) return;
    for (const n of nodes) {
      try {
        const until = await this.cache.get<number>(`lavalink:cooldown:${n.identifier}`);
        if (until && until > Date.now()) {
          this.nodeCooldownUntil.set(n.identifier, until);
          const remaining = Math.ceil((until - Date.now()) / 1000);
          Logger.info(`[Lavalink] Restored cooldown for "${n.identifier}" — ${remaining}s remaining (from previous session)`);
        }
      } catch { /* ignore */ }
    }
  }

  private persistCooldownDelete(identifier: string): void {
    if (this.cache) void this.cache.delete(`lavalink:cooldown:${identifier}`).catch(() => undefined);
  }

  private scheduleReconnect(node: Node, delayMs: number): void {
    const id = node.identifier;
    const existing = this.reconnectTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(id);
      if (node.destroyed) return;
      if (this.isNodeInCooldown(id)) {
        return;
      }
      Logger.info(`[Lavalink] Manually reconnecting node "${id}" (${node.host}:${node.port})`);
      try {
        await node.connect();
      } catch (err) {
        Logger.debug({ err, node: id }, `Manual reconnect for "${id}" failed`);
        this.scheduleReconnect(node, Math.min(delayMs * 1.5, 3600000));
      }
    }, delayMs);

    this.reconnectTimers.set(id, timer);
  }

  private clearReconnectTimer(identifier: string): void {
    const timer = this.reconnectTimers.get(identifier);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(identifier);
    }
  }

  private registerNodeEvents(): void {
    this.manager.on('nodeConnected', (node: Node) => {
      Logger.info(`[Lavalink] Node "${node.identifier}" connected (${node.host}:${node.port})`);
      this.nodeCooldownUntil.delete(node.identifier);
      this.persistCooldownDelete(node.identifier);
      this.nodeReconnectAttempts.delete(node.identifier);
      this.clearReconnectTimer(node.identifier);
    });

    this.manager.on('nodeDisconnect', (node: Node, code: number, reason: string) => {
      // Disarm Moonlink's internal reconnect timer so Moonlink does not hammer the server immediately
      setImmediate(() => {
        const rawNode = node as unknown as { reconnectTimeout?: NodeJS.Timeout };
        if (rawNode.reconnectTimeout) {
          clearTimeout(rawNode.reconnectTimeout);
          rawNode.reconnectTimeout = undefined;
        }
      });

      const isRateLimit = code === 4000 || reason?.toLowerCase().includes('too many');
      if (isRateLimit) {
        // Put rate-limited node on a 1-hour cooldown as requested
        const ONE_HOUR = 3600000;
        this.setNodeCooldown(node.identifier, ONE_HOUR);

        const now = Date.now();
        const lastLog = this.lastRateLimitLog.get(node.identifier) ?? 0;
        // Only log once per 10 minutes to keep console completely quiet
        if (now - lastLog > 600000) {
          this.lastRateLimitLog.set(node.identifier, now);
          Logger.info(
            `[Lavalink] Node "${node.identifier}" rate-limited (Code ${code}). Silencing reconnects for 1 hour.`,
          );
        }

        this.scheduleReconnect(node, ONE_HOUR);
        this.handleNodeFailover(node);
        return;
      }

      // Public nodes are flaky — 1006/ENOTFOUND/EPROTO are expected, don't spam WARN
      const isExpectedFlake =
        code === 1006 ||
        reason?.includes('ENOTFOUND') ||
        reason?.includes('EPROTO') ||
        reason?.includes('closed abruptly') ||
        reason?.includes('timeout') ||
        reason?.includes('hang up');
      if (isExpectedFlake) {
        this.setNodeCooldown(node.identifier, 30000);
        this.scheduleReconnect(node, 30000);
        this.handleNodeFailover(node);
        return;
      }

      Logger.debug(
        { node: node.identifier, host: node.host, code, reason: reason?.slice(0, 100) },
        `[Lavalink] Node "${node.identifier}" disconnected. Failover active.`,
      );
      this.handleNodeFailover(node);
      this.setNodeCooldown(node.identifier, 30000);
      this.scheduleReconnect(node, 30000);
    });

    this.manager.on('nodeReconnect', (node: Node) => {
      Logger.debug(`[Lavalink] Node "${node.identifier}" reconnected`);
    });

    this.manager.on('nodeError', (node: Node, error: Error) => {
      const errMsg = error?.message || String(error);
      // Public nodes spam EPROTO/ENOTFOUND — downgrade to debug unless it's a real auth error
      const isFlake = errMsg.includes('ENOTFOUND') || errMsg.includes('EPROTO') || errMsg.includes('timeout') || errMsg.includes('hang up');
      if (isFlake) {
        Logger.debug({ node: node.identifier, err: errMsg.slice(0, 80) }, `[Lavalink] Node "${node.identifier}" flaked`);
        return;
      }
      Logger.warn({ node: node.identifier, err: error }, `[Lavalink] Node "${node.identifier}" error: ${errMsg.slice(0, 80)}`);

      if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('Too Many Requests')) {
        Logger.debug(`[Lavalink] 429 Rate Limit encountered on "${node.identifier}". Migrating players...`);
        this.handleNodeFailover(node);
      }
    });

    this.manager.on('playerSwitchedNode', (player: Player, oldNode: Node, newNode: Node) => {
      Logger.info(
        `[Lavalink] Player for guild ${player.guildId} migrated smoothly from "${oldNode.identifier}" to "${newNode.identifier}"`,
      );
    });

    this.manager.on('playerDestroy', (player: Player, reason?: string) => {
      Logger.debug(`[Lavalink] Player for guild ${player.guildId} destroyed (${reason || 'no reason'})`);
    });
  }

  private startHealthCheckLoop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Health check loop every 10 seconds
    this.healthCheckInterval = setInterval(() => {
      this.checkNodesHealth();
    }, 10000);
  }

  private checkNodesHealth(): void {
    try {
      const allNodes = this.getAllNodes();
      for (const node of allNodes) {
        if (!node.connected) continue;

        const stats = node.stats;
        if (!stats) continue;

        // Check high CPU or degraded node
        const lavalinkCpu = stats.cpu?.lavalinkLoad ?? 0;
        const systemCpu = stats.cpu?.systemLoad ?? 0;

        if (lavalinkCpu > 0.9 || systemCpu > 0.95) {
          Logger.warn(
            `[Lavalink] Node "${node.identifier}" is under extreme load (CPU: ${(lavalinkCpu * 100).toFixed(1)}%). Evaluating rebalance...`,
          );
        }
      }
    } catch (err) {
      Logger.debug({ err }, 'Error in Lavalink health check loop');
    }
  }

  public handleNodeFailover(failedNode: Node): void {
    try {
      const players: Player[] = this.manager.players?.all ?? [];
      const affectedPlayers = players.filter(
        (p) => p.node?.identifier === failedNode.identifier,
      );

      // If no active players were on this node, nothing needs migrating
      if (affectedPlayers.length === 0) {
        return;
      }

      const allNodes = this.getAllNodes();
      const healthyNodes = allNodes.filter(
        (n) => n.connected && n.identifier !== failedNode.identifier && !this.isNodeInCooldown(n.identifier),
      );

      if (healthyNodes.length === 0) {
        Logger.warn('[Lavalink] Active players cannot migrate: no healthy backup nodes currently connected (or all on cooldown). Waiting for reconnect...');
        return;
      }

      // Pick healthiest node with lowest load / players
      const targetNode = healthyNodes.sort((a, b) => {
        const aPlayers = a.stats?.players ?? 0;
        const bPlayers = b.stats?.players ?? 0;
        return aPlayers - bPlayers;
      })[0];

      if (!targetNode) return;

      for (const player of affectedPlayers) {
        Logger.info(
          `[Lavalink] Moving player ${player.guildId} from failed node "${failedNode.identifier}" to "${targetNode.identifier}"`,
        );
        player
          .transferNode(targetNode)
          .catch((err) => {
            Logger.error({ err, guildId: player.guildId }, 'Failed to move player to backup node');
          });
      }
    } catch (err) {
      Logger.error({ err }, 'Error during node failover');
    }
  }

  public hasHealthyNode(): boolean {
    if (!this.lavalinkEnabled) return false;
    const allNodes = this.getAllNodes();
    return allNodes.some(n => n.connected && !this.isNodeInCooldown(n.identifier) && n.identifier !== 'dummy-disabled');
  }

  public getHealthyNodeCount(): number {
    if (!this.lavalinkEnabled) return 0;
    const allNodes = this.getAllNodes();
    return allNodes.filter(n => n.connected && !this.isNodeInCooldown(n.identifier) && n.identifier !== 'dummy-disabled').length;
  }

  public getNodeStats(): LavalinkNodeStats[] {
    if (!this.lavalinkEnabled) return [];
    const result: LavalinkNodeStats[] = [];
    const allNodes = this.getAllNodes();

    for (const node of allNodes) {
      if (node.identifier === 'dummy-disabled') continue;
      const stats = node.stats;
      const inCooldown = this.isNodeInCooldown(node.identifier);
      result.push({
        identifier: node.identifier + (inCooldown ? ' (cooldown)' : ''),
        host: node.host,
        port: node.port,
        connected: Boolean(node.connected) && !inCooldown,
        players: stats?.players ?? 0,
        playingPlayers: stats?.playingPlayers ?? 0,
        cpuLoad: stats?.cpu?.systemLoad ? Number((stats.cpu.systemLoad * 100).toFixed(1)) : 0,
        lavalinkLoad: stats?.cpu?.lavalinkLoad ? Number((stats.cpu.lavalinkLoad * 100).toFixed(1)) : 0,
        memoryUsedMb: stats?.memory?.used ? Math.round(stats.memory.used / 1024 / 1024) : 0,
        memoryAllocatedMb: stats?.memory?.allocated ? Math.round(stats.memory.allocated / 1024 / 1024) : 0,
        uptimeMs: stats?.uptime ?? 0,
        ping: (node as unknown as { ping?: number }).ping ?? 0,
      });
    }

    return result;
  }

  public stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
  }
}
