import http from 'http';
import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { Logger } from '@domain/logger';
import { checkDatabaseHealth } from '@persistence/prismaClient';
import { PuppeteerService } from '@images/generators/puppeteerService';

export class HealthServer {
  private server: http.Server | null = null;
  private port: number = 3000;

  public start(port = 3000): void {
    if (this.server) return;
    this.port = Number(process.env.HEALTH_PORT || process.env.PORT || port);

    this.server = http.createServer(async (req, res) => {
      const url = req.url?.split('?')[0] || '/';

      if (url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
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
          const isHealthy = dbHealth.healthy;
          const statusCode = isHealthy ? 200 : 503;

          const response = {
            status: isHealthy ? 'healthy' : 'unhealthy',
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
      if (err.code === 'EADDRINUSE') {
        Logger.warn(`Health check port ${this.port} is already in use; health endpoint skipped.`);
      } else {
        Logger.warn({ err }, 'Health server error');
      }
      this.server = null;
    });

    // Unref server so it doesn't block node exit if shutdown is initiated
    this.server.unref();
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
