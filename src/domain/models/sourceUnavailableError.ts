/**
 * A data source failed. It did not answer.
 *
 * This is the distinction that `null` and `[]` could not carry. Every read used
 * to return an empty value for both "the source says this does not exist" and
 * "the source is unreachable", so a 5xx or a dropped connection rendered as a
 * confident zero - and a confident zero is worse than a visible error, because
 * the user cannot tell it apart from the truth. A failure is not an answer, so
 * it is raised rather than returned.
 *
 * It lives in `domain` rather than beside any one consumer because `bot/`,
 * `lastfm/` and `persistence/` all need to raise it, and because a consumer
 * that catches it and treats the failure as a definitive miss (caching "no
 * artwork exists", for instance) reintroduces exactly the lie this type exists
 * to prevent.
 *
 * `LastFmUnavailableError` is the first implementation and extends this, so an
 * existing `instanceof`/`isLastFmUnavailable` check keeps working unchanged
 * while a database outage is distinguishable from a Last.fm outage.
 */
export class SourceUnavailableError extends Error {
  constructor(
    public readonly method: string,
    public readonly cause: unknown,
    /** What to call the failing thing in the message. */
    label = 'Source unavailable',
    /** Overrides `this.name`; the base name keeps `isSourceUnavailable` honest. */
    name = 'SourceUnavailableError',
  ) {
    super(`${label} during ${method}: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = name;
  }
}

/**
 * TRUE for this family specifically, safe across module instances.
 *
 * The `name` check is deliberate rather than an `instanceof`: the same class
 * is loaded through several module specifiers in this repo, and an
 * `instanceof` against one copy silently misses the others - which is how a
 * "handled" failure becomes a silent one again.
 */
export const isSourceUnavailable = (err: unknown): err is SourceUnavailableError =>
  err instanceof Error &&
  (err.name === 'SourceUnavailableError' || err.name === 'LastFmUnavailableError');
