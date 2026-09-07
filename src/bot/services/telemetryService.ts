import { singleton } from 'tsyringe';
import { Logger } from '@domain/logger';

export interface CommandMetric {
  commandName: string;
  executions: number;
  failures: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  recentLatencies: number[];
}

export interface ApiCallMetric {
  service: string;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  rateLimitedCalls: number;
  lastErrorTimestamp?: Date;
  lastErrorMessage?: string;
}

export interface HealthMetricsReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptimeSeconds: number;
  memoryUsageMb: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  totalCommandExecutions: number;
  totalCommandFailures: number;
  commandFailureRate: number;
  topCommands: Array<{
    command: string;
    calls: number;
    avgMs: number;
    p95Ms: number;
  }>;
  externalApis: Record<string, ApiCallMetric>;
}

@singleton()
export class TelemetryService {
  private readonly commandMetrics = new Map<string, CommandMetric>();
  private readonly apiMetrics = new Map<string, ApiCallMetric>();
  private readonly startTime = Date.now();
  private readonly maxRollingHistory = 100;

  /**
   * Record execution of a command (text or slash)
   */
  public recordCommandExecution(commandName: string, durationMs: number, success: boolean = true): void {
    const name = commandName.toLowerCase().replace(/^\./, '').trim();
    let metric = this.commandMetrics.get(name);

    if (!metric) {
      metric = {
        commandName: name,
        executions: 0,
        failures: 0,
        totalDurationMs: 0,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        recentLatencies: [],
      };
      this.commandMetrics.set(name, metric);
    }

    metric.executions++;
    if (!success) metric.failures++;
    metric.totalDurationMs += durationMs;
    if (durationMs < metric.minDurationMs) metric.minDurationMs = durationMs;
    if (durationMs > metric.maxDurationMs) metric.maxDurationMs = durationMs;

    metric.recentLatencies.push(durationMs);
    if (metric.recentLatencies.length > this.maxRollingHistory) {
      metric.recentLatencies.shift();
    }
  }

  /**
   * Get raw metrics for a specific command
   */
  public getCommandMetric(commandName: string): CommandMetric | undefined {
    const name = commandName.toLowerCase().replace(/^\./, '').trim();
    return this.commandMetrics.get(name);
  }

  /**
   * Record external API call result (Last.fm, Spotify, Discord, MusicBrainz)
   */
  public recordApiCall(
    service: 'lastfm' | 'spotify' | 'discord' | 'musicbrainz',
    endpoint: string,
    durationMs: number,
    statusCode: number,
    errorMessage?: string,
  ): void {
    let metric = this.apiMetrics.get(service);

    if (!metric) {
      metric = {
        service,
        totalCalls: 0,
        successCalls: 0,
        errorCalls: 0,
        rateLimitedCalls: 0,
      };
      this.apiMetrics.set(service, metric);
    }

    metric.totalCalls++;
    const isSuccess = statusCode >= 200 && statusCode < 400;
    if (isSuccess) {
      metric.successCalls++;
    } else {
      metric.errorCalls++;
      metric.lastErrorTimestamp = new Date();
      if (errorMessage) metric.lastErrorMessage = errorMessage;
      if (statusCode === 429) {
        metric.rateLimitedCalls++;
        Logger.warn(`[Telemetry] API ${service} hit 429 rate limit on ${endpoint}`);
      }
    }
  }

  /**
   * Calculate percentile (e.g. 50th, 95th, 99th) from latency sample array
   */
  public calculatePercentile(latencies: number[], percentile: number): number {
    if (latencies.length === 0) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
  }

  /**
   * Get health report summary
   */
  public getHealthMetrics(): HealthMetricsReport {
    const mem = process.memoryUsage();
    let totalCommands = 0;
    let totalFailures = 0;

    const topCommandsList: Array<{ command: string; calls: number; avgMs: number; p95Ms: number }> = [];

    for (const [name, metric] of this.commandMetrics) {
      totalCommands += metric.executions;
      totalFailures += metric.failures;
      const avg = metric.executions > 0 ? Math.round(metric.totalDurationMs / metric.executions) : 0;
      const p95 = this.calculatePercentile(metric.recentLatencies, 95);
      topCommandsList.push({
        command: name,
        calls: metric.executions,
        avgMs: avg,
        p95Ms: p95,
      });
    }

    topCommandsList.sort((a, b) => b.calls - a.calls);

    const failRate = totalCommands > 0 ? (totalFailures / totalCommands) * 100 : 0;
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (failRate > 15) {
      status = 'unhealthy';
    } else if (failRate > 5) {
      status = 'degraded';
    }

    const apiObj: Record<string, ApiCallMetric> = {};
    for (const [k, v] of this.apiMetrics) {
      apiObj[k] = { ...v };
    }

    return {
      status,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      memoryUsageMb: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
      },
      totalCommandExecutions: totalCommands,
      totalCommandFailures: totalFailures,
      commandFailureRate: Math.round(failRate * 10) / 10,
      topCommands: topCommandsList.slice(0, 10),
      externalApis: apiObj,
    };
  }

  /**
   * Reset or clear metrics (e.g. for testing)
   */
  public reset(): void {
    this.commandMetrics.clear();
    this.apiMetrics.clear();
  }
}
