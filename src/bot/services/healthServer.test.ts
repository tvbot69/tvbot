import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import { HealthServer } from './healthServer';

describe('HealthServer', () => {
  let server: HealthServer | null = null;
  const testPort = 3999;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('starts and responds to /ping with 200 pong', async () => {
    server = new HealthServer();
    server.start(testPort);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`http://localhost:${testPort}/ping`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('pong');
  });

  it('responds to /health with JSON containing status and diagnostics', async () => {
    server = new HealthServer();
    server.start(testPort);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`http://localhost:${testPort}/health`);
    expect([200, 503]).toContain(res.status);
    const data = (await res.json()) as {
      status: string;
      uptimeSeconds: number;
      database: { status: string };
      memory: { rssMb: number };
    };

    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('uptimeSeconds');
    expect(data).toHaveProperty('database');
    expect(data).toHaveProperty('memory');
    expect(typeof data.memory.rssMb).toBe('number');
  }, 15000);

  it('shuts down cleanly with stop()', async () => {
    server = new HealthServer();
    server.start(testPort);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.stop();

    await expect(fetch(`http://localhost:${testPort}/ping`)).rejects.toThrow();
  });
});
