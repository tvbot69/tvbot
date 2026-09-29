/**
 * Last.fm answered, but not with an answer.
 *
 * This is the distinction that `null` could not carry. Every read in
 * `lastFmRepository` used to return `null` or `[]` for both "Last.fm says this
 * does not exist" and "Last.fm is unreachable", so a 5xx or a timeout rendered
 * as a confident "this account does not exist" - including telling a user their
 * friend had been removed. A network failure is not an answer, so it is raised
 * rather than returned.
 *
 * Lives in `domain` rather than beside the repository because `bot/` needs to
 * recognise it: a consumer that catches it and treats the failure as a
 * definitive miss (caching "no artwork exists", for instance) reintroduces
 * exactly the lie this type exists to prevent.
 */
export class LastFmUnavailableError extends Error {
  constructor(
    public readonly method: string,
    public readonly cause: unknown,
  ) {
    super(
      `Last.fm unavailable during ${method}: ${
        (cause as Error)?.message ?? String(cause)
      }`,
    );
    this.name = 'LastFmUnavailableError';
  }
}

/** TRUE for this error specifically, safe across module instances. */
export const isLastFmUnavailable = (err: unknown): err is LastFmUnavailableError =>
  err instanceof Error && err.name === 'LastFmUnavailableError';
