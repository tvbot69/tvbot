/**
 * The telemetry capability `src/lastfm` is allowed to depend on.
 *
 * `lastfmApi` was reaching for `TelemetryService` through the service locator -
 * `container.isRegistered(TelemetryService)` then `container.resolve(...)` - from
 * inside a lower layer. That is the hybrid DI style the plan's 3.3 exists to
 * remove, and it has a specific cost: the dependency is invisible in the
 * constructor, so nothing in the wiring graph knows the API client reports to
 * telemetry, and a test double cannot intercept it without a container.
 *
 * Injected through the constructor instead, behind a string token, so
 * `src/lastfm` names a capability from `@domain` rather than a class from
 * `@bot/*`.
 *
 * Deliberately one method. `TelemetryService` is much larger; this is what a
 * Last.fm caller needs, and nothing more.
 */

/** Injection token for {@link ITelemetry}. A string so `src/` need not import the class. */
export const ITELEMETRY = 'ITelemetry';

/** The services a caller may attribute a call to. Mirrors the service's own union. */
export type TelemetryServiceName = 'lastfm' | 'spotify' | 'discord' | 'musicbrainz';

export interface ITelemetry {
  /**
   * Record one outbound API call.
   *
   * Callers must treat this as best-effort: a telemetry failure must never fail
   * the API call it is describing. `lastfmApi` wraps this in its own try/catch
   * for exactly that reason.
   */
  recordApiCall(
    service: TelemetryServiceName,
    endpoint: string,
    durationMs: number,
    statusCode: number,
    errorMessage?: string,
  ): void;
}
