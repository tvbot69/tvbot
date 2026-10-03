import http from 'http';
import type { ServerResponse } from 'http';
import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { Logger } from '@domain/logging/logger';
import { checkDatabaseHealth } from '@persistence/prismaClient';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { TelemetryService } from '@bot/services/system/telemetryService';
import { healthPort } from '@config/runtimeEnv';

export class HealthServer {
  private server: http.Server | null = null;
  private port: number = 3000;
  private basePort: number = 3000;
  private static readonly PORT_PROBE_RANGE = 16;
  /** Serve a cached snapshot for this long instead of re-probing the DB. */
  private static readonly HEALTH_CACHE_MS = 5_000;
  /**
   * How long after boot the Discord gateway is reported but NOT required.
   *
   * A cold start legitimately has no gateway for a while: the container is
   * booting, `prisma migrate deploy` has not returned, and the client is not
   * even registered yet. Requiring it immediately would answer 503 to the
   * platform for the whole of that window and a slow boot would be reported as
   * a failed deploy.
   *
   * After this window it becomes load-bearing, and a gateway that is resolvable
   * but not ready is a dead bot rather than a starting one. That is the
   * distinction that matters: "I have not asked yet" and "I asked and it is
   * down" are not the same state, and only the second should fail a deploy.
   */
  private static readonly GATEWAY_GRACE_MS = 180_000;
  private startedAt = 0;
  private draining = false;

  /** Called on SIGTERM: readiness fails closed while in-flight work drains. */
  public setDraining(): void {
    this.draining = true;
  }

  public start(port = 3000): void {
    if (this.server) return;
    this.basePort = healthPort(port);
    this.port = this.basePort;
    this.startedAt = Date.now();

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

      if (url === '/metrics') {
        // Sanitized telemetry snapshot. Fixed shape, aggregate counters only:
        // no per-user/per-guild labels, no error message strings (they can
        // embed tokens or PII from provider bodies), service keys are the
        // bounded telemetry set. Note: 384MB heap — no raw latency arrays,
        // topCommands stays capped at 10, nothing cached per request.
        try {
          // Same resolve pattern as Client/Puppeteer above: try resolve,
          // fail closed on throw. No isRegistered guard: TelemetryService is
          // `@singleton()` so the token stays registered after import and the
          // guard would never fire; a fresh resolve is an empty zero-traffic
          // report, which is truthful, not fabricated.
          const telemetry = container.resolve(TelemetryService);
          const report = telemetry.getHealthMetrics();
          const externalApis: Record<
            string,
            { totalCalls: number; successCalls: number; errorCalls: number; rateLimitedCalls: number }
          > = {};
          for (const [service, metric] of Object.entries(report.externalApis)) {
            externalApis[service] = {
              totalCalls: metric.totalCalls,
              successCalls: metric.successCalls,
              errorCalls: metric.errorCalls,
              rateLimitedCalls: metric.rateLimitedCalls,
            };
          }
          this.writeJson(res, 200, {
            status: report.status,
            uptimeSeconds: report.uptimeSeconds,
            memoryUsageMb: { ...report.memoryUsageMb },
            totalCommandExecutions: report.totalCommandExecutions,
            totalCommandFailures: report.totalCommandFailures,
            commandFailureRate: report.commandFailureRate,
            topCommands: report.topCommands.slice(0, 10).map((c) => ({
              command: c.command,
              calls: c.calls,
              avgMs: c.avgMs,
              p95Ms: c.p95Ms,
            })),
            externalApis,
          });
        } catch (err) {
          Logger.debug({ err }, '[Health] TelemetryService not resolvable yet');
          this.writeJson(res, 503, { status: 'unavailable' });
        }
        return;
      }

      if (url === '/health' || url === '/') {
        // Short cache: this endpoint runs a real `SELECT 1` and is polled by
        // the platform, so an unauthenticated caller could otherwise occupy
        // the same small connection pool every user command needs.
        const cached = this.cachedHealth();
        if (cached) {
          this.writeJson(res, cached.statusCode, cached.body);
          return;
        }
        try {
          const dbHealth = await checkDatabaseHealth();
          let discordPing = -1;
          let discordStatus = 'not_initialized';

          try {
            const client = container.resolve(Client);
            discordPing = client.ws.ping;
            discordStatus = client.isReady() ? 'ready' : 'connecting';
          } catch (err) {
            // NOT "CORRECT AS IS" any more. This block used to be excused
            // because `discord` was a reported field and never part of the
            // verdict — which meant a bot with no gateway answered 200 healthy
            // forever and Railway restarted nothing. The status is now judged
            // below (after a boot grace window), so an unresolvable client is a
            // real failure rather than an unreported one. What this catch still
            // must not do is claim 'ready', and `not_initialized` does not.
            Logger.debug({ err }, '[Health] Discord client not resolvable yet');
          }

          let puppeteerAlive = false;
          try {
            const puppeteer = container.resolve(PuppeteerService);
            puppeteerAlive = await puppeteer.isHealthy();
          } catch (err) {
            // CORRECT AS IS: decoration, and the reported value is literally what
            // was measured. `puppeteer.ready` is false when it is unwarmed, which
            // is the same answer, and it is excluded from the status code.
            Logger.debug({ err }, '[Health] Puppeteer not resolvable yet');
          }

          const mem = process.memoryUsage();
          // The gateway is load-bearing AFTER the boot grace window. Before it,
          // a cold start has no client yet and requiring one would 503 every
          // healthcheck for the length of the boot.
          //
          // The only thing that must never happen is reporting `ready` when it
          // is not — so an unresolvable client inside the grace window reports
          // 'not_initialized' and is not judged, and outside it the same
          // failure IS judged. Railway probes this path, so a bot that has lost
          // its gateway indefinitely now returns 503 instead of sitting at 200
          // healthy while serving nobody.
          const withinGrace = Date.now() - this.startedAt < HealthServer.GATEWAY_GRACE_MS;
          const gatewayOk = withinGrace || discordStatus === 'ready';
          const isHealthy = dbHealth.healthy && gatewayOk && !this.draining;
          const statusCode = isHealthy ? 200 : 503;

          if (!gatewayOk) {
            Logger.error(
              { discordStatus, withinGrace },
              '[Health] Discord gateway is not ready — reporting unhealthy so the platform can restart this bot',
            );
          }

          const response = {
            status: this.draining ? 'draining' : isHealthy ? 'healthy' : 'unhealthy',
            draining: this.draining,
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
            database: {
              status: dbHealth.healthy ? 'connected' : 'error',
              latencyMs: dbHealth.latencyMs,
              // NOT the raw Prisma message: it embeds the datasource host,
              // port, user and database name, and this endpoint is reachable
              // from outside. The detail goes to the log instead.
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
          if (!dbHealth.healthy) {
            Logger.warn({ err: dbHealth.error }, '[Health] Database unhealthy');
          }
          this.rememberHealth(statusCode, response);
          this.writeJson(res, statusCode, response);
        } catch (err) {
          Logger.error({ err }, '[Health] probe failed');
          this.writeJson(res, 500, { status: 'error' });
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

  /** 5s health snapshot cache — the probe must not hammer the DB pool. */
  private healthCache: { at: number; statusCode: number; body: unknown } | null = null;

  private cachedHealth(): { statusCode: number; body: unknown } | null {
    if (!this.healthCache) return null;
    if (Date.now() - this.healthCache.at > HealthServer.HEALTH_CACHE_MS) return null;
    return { statusCode: this.healthCache.statusCode, body: this.healthCache.body };
  }

  private rememberHealth(statusCode: number, body: unknown): void {
    this.healthCache = { at: Date.now(), statusCode, body };
  }

  private writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
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
    } catch (err) {
      // CORRECT AS IS, and it fails CLOSED, which is the only acceptable
      // direction: `ready` requires `discordStatus === 'ready'`, so a resolve
      // failure answers 503 rather than a false ready. Reported as
      // 'not_initialized' rather than a raised error, because /readyz is polled
      // and during boot the client genuinely is not resolvable yet.
      Logger.debug({ err }, '[Health] Discord client not resolvable yet');
    }

    let lavalinkHealthyNodes = 0;
    try {
      const { MoonlinkManager } = await import('@bot/services/music/moonlinkManager');
      if (container.isRegistered(MoonlinkManager)) {
        lavalinkHealthyNodes = container.resolve(MoonlinkManager).getHealthyNodeCount();
      }
    } catch (err) {
      // CORRECT AS IS: zero is the value this reports for a disabled music stack
      // too, and the line below fixes its meaning — "Lavalink at zero is
      // degraded, not unready". Readiness is decided by Discord and the database
      // only, so an import failure cannot fail a deploy or hide a real outage.
      Logger.debug({ err }, '[Health] MoonlinkManager not resolvable; reporting zero healthy nodes');
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
