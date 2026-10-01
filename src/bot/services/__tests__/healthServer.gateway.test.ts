import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthServer } from '../system/healthServer';
import { container } from 'tsyringe';
// A VALUE import: `healthServer` resolves the Client token by identity at
// runtime, so `import type` would give this file a name with no value and
// `container.registerInstance(Client, …)` would throw ReferenceError.
import { Client } from 'discord.js';

/**
 * Pin the database to healthy for every test in this file.
 *
 * Without this the endpoint's status code is a product of TWO independent
 * things — the gateway and a live `SELECT 1` against whatever DATABASE_URL
 * happens to hold — and a test asserting on the code cannot say which one
 * produced it. That is how a "test" like `expect([200, 503]).toContain(status)`
 * in healthServer.test.ts ends up passing against the bug and the fix alike.
 *
 * With the database pinned, every status code below is attributable to the
 * gateway alone, which is the entire subject of this file.
 */
vi.mock('@persistence/prismaClient', () => ({
  checkDatabaseHealth: vi.fn(async () => ({ healthy: true, latencyMs: 1 })),
}));

/**
 * Why this file exists
 *
 * Railway's healthcheck probes `/health` (`railway.json` -> `healthcheckPath`).
 * That endpoint computed `isHealthy = dbHealth.healthy && !this.draining` — the
 * Discord status was *reported* but never *judged*. So a bot that had lost its
 * gateway answered `200 healthy` indefinitely, and the platform restarted
 * nothing. The failure mode is the worst kind: silent, permanent, and it looks
 * like health.
 *
 * `/readyz` already did the right thing (it requires `discordStatus === 'ready'`),
 * but nothing was pointed at it. Rather than re-point the platform, the verdict
 * in `/health` now accounts for the gateway — after a boot grace window, so a
 * cold start is not mistaken for an outage.
 *
 * THE POINT OF THESE TESTS is the third one: the existing `/health` test asserts
 * `expect([200, 503]).toContain(res.status)`, which passes against BOTH the bug
 * and the fix. A test that cannot tell the fix from the defect is decoration.
 */

/** Force the boot grace window open or closed without waiting 3 real minutes. */
const setUptime = (server: HealthServer, ms: number): void => {
  (server as unknown as { startedAt: number }).startedAt = Date.now() - ms;
};

const GRACE_MS = 180_000;

/**
 * tsyringe 4.x has no `unregister`. `clearInstances()` is the documented way to
 * drop every registered instance, and it is safe in this file because each test
 * establishes the container state it needs. Without it the Client registered by
 * one test leaks into the next, and "unresolvable" can never be reached.
 */
const withClient = async (isReady: boolean, run: () => Promise<void>): Promise<void> => {
  const fake = {
    ws: { ping: 42 },
    isReady: () => isReady,
  } as unknown as Client;
  container.registerInstance(Client, fake);
  try {
    await run();
  } finally {
    container.clearInstances();
  }
};

describe('HealthServer — the gateway is part of the verdict', () => {
  let server: HealthServer | null = null;
  const testPort = 3998;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    container.clearInstances();
    vi.restoreAllMocks();
  });

  const getHealth = async (port: number): Promise<{ status: number; body: { status: string; discord: { status: string } } }> => {
    const res = await fetch(`http://localhost:${port}/health`);
    return { status: res.status, body: (await res.json()) as never };
  };

  it('a healthy database with a DEAD gateway answers 503, not 200', async () => {
    // The regression this whole file is for. With the gateway down and the boot
    // grace elapsed, the endpoint must fail — otherwise a disconnected bot is
    // reported healthy forever.
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));
    setUptime(server, GRACE_MS + 10_000);

    await withClient(false, async () => {
      const { status, body } = await getHealth(testPort);
      expect(body.discord.status).toBe('connecting');
      expect(status).toBe(503);
      expect(body.status).toBe('unhealthy');
    });
  });

  it('an UNRESOLVABLE client past the grace window also answers 503', async () => {
    // The second half of the bug: the old code excused this catch as
    // "CORRECT AS IS" precisely because a resolve failure could not turn a 503
    // into a 200. That was true, and it was also why the bot stayed up forever.
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));
    setUptime(server, GRACE_MS + 10_000);

    container.clearInstances();
    const { status, body } = await getHealth(testPort);
    expect(body.discord.status).toBe('not_initialized');
    expect(status).toBe(503);
  });

  it('a cold start inside the grace window is NOT failed for having no gateway yet', async () => {
    // The regression this fix could most easily have caused. Requiring the
    // gateway immediately would 503 every healthcheck for the length of a boot
    // and report a slow start as a failed deploy.
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));
    setUptime(server, 1_000);

    container.clearInstances();
    const { status, body } = await getHealth(testPort);
    // With the database pinned healthy, a 200 here is only possible if the
    // grace window genuinely spared the gateway. This fails against the bug.
    expect(body.discord.status).toBe('not_initialized');
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
  });

  it('a healthy database with a READY gateway past the grace window answers 200', async () => {
    // The other direction. Without this, "always 503" would pass every test
    // above and the fix would have turned into a different outage.
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));
    setUptime(server, GRACE_MS + 10_000);

    await withClient(true, async () => {
      const { status, body } = await getHealth(testPort);
      expect(body.discord.status).toBe('ready');
      expect(status).toBe(200);
      expect(body.status).toBe('healthy');
    });
  });

  it('draining fails closed regardless of the gateway', async () => {
    // The pre-existing behaviour must survive the change: SIGTERM has to stop
    // advertising health while in-flight work drains, or a deploy rolling
    // through this endpoint would take traffic it cannot serve.
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));
    setUptime(server, 1_000);
    server.setDraining();

    await withClient(true, async () => {
      const { status, body } = await getHealth(testPort);
      expect(status).toBe(503);
      expect(body.status).toBe('draining');
    });
  });
});
