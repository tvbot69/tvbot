import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { HealthServer } from '@bot/services/system/healthServer';
import { TelemetryService } from '@bot/services/system/telemetryService';

describe('HealthServer /metrics', () => {
  let server: HealthServer | null = null;
  const testPort = 3997;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    container.clearInstances();
  });

  it('returns a sanitized metrics shape with no error message strings', async () => {
    const telemetry = new TelemetryService();
    telemetry.recordCommandExecution('play', 10, true);
    telemetry.recordApiCall('spotify', '/v1/search', 10, 500, 'SECRET_TOKEN_abc123 do not leak');
    container.registerInstance(TelemetryService, telemetry);

    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://localhost:${testPort}/metrics`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('SECRET_TOKEN_abc123');
    expect(raw).not.toContain('lastErrorMessage');

    const body = JSON.parse(raw) as {
      status: string;
      uptimeSeconds: number;
      memoryUsageMb: { heapUsed: number; heapTotal: number; rss: number };
      totalCommandExecutions: number;
      totalCommandFailures: number;
      commandFailureRate: number;
      topCommands: Array<{ command: string; calls: number; avgMs: number; p95Ms: number }>;
      externalApis: Record<string, Record<string, unknown>>;
    };
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.memoryUsageMb.heapUsed).toBe('number');
    expect(body.totalCommandExecutions).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.topCommands)).toBe(true);
    expect(body.topCommands.length).toBeLessThanOrEqual(10);
    for (const cmd of body.topCommands) {
      expect(Object.keys(cmd).sort()).toEqual(['avgMs', 'calls', 'command', 'p95Ms']);
    }
    expect(body.externalApis.spotify?.totalCalls).toBe(1);
    expect(body.externalApis.spotify?.errorCalls).toBe(1);
    expect(body.externalApis.spotify).not.toHaveProperty('lastErrorMessage');
  });

  it('returns an empty but well-shaped report when no traffic was recorded', async () => {
    // Mutation guard: a fresh resolve must still be a 200 with zero counts,
    // not a 503 or a crash. tsyringe `@singleton()` stays registered after
    // import, so there is no reachable "unregistered" state to fail closed on.
    container.clearInstances();
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://localhost:${testPort}/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      totalCommandExecutions: number;
      topCommands: unknown[];
      externalApis: Record<string, unknown>;
    };
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(body.totalCommandExecutions).toBe(0);
    expect(body.topCommands).toEqual([]);
    expect(body.externalApis).toEqual({});
  });

  it('still answers 404 for unknown paths', async () => {
    container.registerInstance(TelemetryService, new TelemetryService());
    server = new HealthServer();
    server.start(testPort);
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://localhost:${testPort}/definitely-not-here`);
    expect(res.status).toBe(404);
  });
});
