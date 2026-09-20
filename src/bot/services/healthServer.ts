import http from 'http';
import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { Logger } from '@domain/logger';
import { checkDatabaseHealth } from '@persistence/prismaClient';
import { PuppeteerService } from '@images/generators/puppeteerService';

export class HealthServer {
  private server: http.Server | null = null;
  private port: number = 3000;
  private basePort: number = 3000;
  private static readonly PORT_PROBE_RANGE = 16;
  private draining = false;

  /** Called on SIGTERM: readiness fails closed while in-flight work drains. */
  public setDraining(): void {
    this.draining = true;
  }

  public start(port = 3000): void {
    if (this.server) return;
    this.basePort = Number(process.env.HEALTH_PORT || process.env.PORT || port);
    this.port = this.basePort;

    this.server = http.createServer(async (req, res) => {
      const url = req.url?.split('?')[0] || '/';

      if (url === '/ping' || url === '/livez') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
        return;
      }

      if (url === '/readyz') {
        const readiness = await this.checkReadiness();
        res.writeHead(readiness.ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readiness));
        return;
      }

      if (url === '/health' || url === '/') {
        try {
          const dbHealth = await checkDatabaseHealth();
          let discordPing = -1;
          let discordStatus = 'not_initialized';

          try {
            const client = container.resolve(Client);
            discordPing = client.ws.ping;
            discordStatus = client.isReady() ? 'ready' : 'connecting';
          } catch {
            // client not yet registered/ready
          }

          let puppeteerAlive = false;
          try {
            const puppeteer = container.resolve(PuppeteerService);
            puppeteerAlive = await puppeteer.isHealthy();
          } catch {
            // puppeteer not yet warmed up
          }

          const mem = process.memoryUsage();
          const isHealthy = dbHealth.healthy && !this.draining;
          const statusCode = isHealthy ? 200 : 503;

          const response = {
            status: this.draining ? 'draining' : isHealthy ? 'healthy' : 'unhealthy',
            draining: this.draining,
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
            database: {
              status: dbHealth.healthy ? 'connected' : 'error',
              latencyMs: dbHealth.latencyMs,
              ...(dbHealth.error ? { error: dbHealth.error } : {}),
            },
            discord: {
              status: discordStatus,
              gatewayPingMs: discordPing,
            },
            puppeteer: {
              ready: puppeteerAlive,
            },
            memory: {
              rssMb: Math.round(mem.rss / 1024 / 1024),
              heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
              heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
            },
          };

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response, null, 2));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: (err as Error)?.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    this.server.listen(this.port, () => {
      Logger.info(`Health check probe listening on http://localhost:${this.port}/health`);
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      // Same-host shard workers share the port range: walk upward instead of
      // going dark. Shard 0 keeps the canonical port for the orchestrator.
      if (err.code === 'EADDRINUSE' && this.port < this.basePort + HealthServer.PORT_PROBE_RANGE) {
        this.port++;
        Logger.info(`Health check port taken, trying ${this.port}...`);
        this.server?.listen(this.port);
        return;
      }
      if (err.code === 'EADDRINUSE') {
        Logger.warn(`Health check ports ${this.basePort}-${this.port} all in use; health endpoint skipped.`);
      } else {
        Logger.warn({ err }, 'Health server error');
      }
      this.server = null;
    });

    // Unref server so it doesn't block node exit if shutdown is initiated
    this.server.unref();
  }

  private async checkReadiness(): Promise<{
    ready: boolean;
    draining: boolean;
    discord: string;
    lavalinkHealthyNodes: number;
    database: string;
    dbLatencyMs?: number;
  }> {
    if (this.draining) {
      return { ready: false, draining: true, discord: 'draining', lavalinkHealthyNodes: 0, database: 'draining' };
    }

    let discordStatus = 'not_initialized';
    try {
      const client = container.resolve(Client);
      discordStatus = client.isReady() ? 'ready' : 'connecting';
    } catch {
      // client not yet registered
    }

    let lavalinkHealthyNodes = 0;
    try {
      const { MoonlinkManager } = await import('./music/moonlinkManager');
      if (container.isRegistered(MoonlinkManager)) {
        lavalinkHealthyNodes = container.resolve(MoonlinkManager).getHealthyNodeCount();
      }
    } catch {
      // music disabled or not wired
    }

    let dbStatus = 'unknown';
    let dbLatencyMs: number | undefined;
    try {
      const dbHealth = await checkDatabaseHealth();
      dbStatus = dbHealth.healthy ? 'connected' : 'error';
      dbLatencyMs = dbHealth.latencyMs;
    } catch {
      dbStatus = 'error';
    }

    // Lavalink at zero is degraded, not unready: music pauses but commands work.
    const ready = discordStatus === 'ready' && dbStatus === 'connected';
    return { ready, draining: false, discord: discordStatus, lavalinkHealthyNodes, database: dbStatus, dbLatencyMs };
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}
