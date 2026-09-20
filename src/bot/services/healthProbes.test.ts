import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import { HealthServer } from './healthServer';

describe('HealthServer probes (Phase 5)', () => {
  const servers: HealthServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.stop().catch(() => undefined)));
    servers.length = 0;
  });

  const startOn = async (port: number): Promise<HealthServer> => {
    const server = new HealthServer();
    servers.push(server);
    server.start(port);
    await new Promise((r) => setTimeout(r, 150));
    return server;
  };

  it('/livez answers even when dependencies are down', async () => {
    await startOn(41901);
    const res = await fetch('http://localhost:41901/livez');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('/readyz fails closed when discord is not ready', async () => {
    await startOn(41902);
    const res = await fetch('http://localhost:41902/readyz');
    // No Discord client registered in test env -> not ready -> 503
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; draining: boolean };
    expect(body.ready).toBe(false);
    expect(body.draining).toBe(false);
  });

  it('/health reports draining during shutdown', async () => {
    const server = await startOn(41903);
    server.setDraining();
    const res = await fetch('http://localhost:41903/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; draining: boolean };
    expect(body.status).toBe('draining');
    expect(body.draining).toBe(true);
  });
});
