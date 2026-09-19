import { Logger } from '@domain/logger';
import { LastfmApiError } from '@domain/models/lastfmError';

export class LastfmErrorRateTracker {
  private totalCalls: number = 0;
  private errorCalls: number = 0;
  private errorsByCode: Map<number, number> = new Map();

  public trackSuccess(): void {
    this.totalCalls++;
  }

  public trackError(error: LastfmApiError): void {
    this.totalCalls++;
    this.errorCalls++;
    this.errorsByCode.set(error.code, (this.errorsByCode.get(error.code) ?? 0) + 1);
  }

  /**
   * True when Last.fm is currently erroring hard — callers gate destructive or
   * money-shot decisions (crown steals, index backfill, autoposts) on this
   * instead of acting on stale data during an outage.
   */
  public isElevated(errorRateThresholdPercent = 25, minCalls = 20): boolean {
    if (this.totalCalls < minCalls) return false;
    return (this.errorCalls / this.totalCalls) * 100 >= errorRateThresholdPercent;
  }

  public logAndReset(): void {
    if (this.totalCalls === 0) {
      return;
    }
    const errorRate = ((this.errorCalls / this.totalCalls) * 100).toFixed(2);
    Logger.warn(
      {
        lastFmErrorRate: `${errorRate}%`,
        totalCalls: this.totalCalls,
        errorCalls: this.errorCalls,
        errorsByCode: Object.fromEntries(this.errorsByCode),
      },
      'Last.fm error rate report',
    );
    this.totalCalls = 0;
    this.errorCalls = 0;
    this.errorsByCode.clear();
  }
}
