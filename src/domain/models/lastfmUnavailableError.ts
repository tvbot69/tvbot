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
 *
 * It is now a thin `SourceUnavailableError` rather than the root of the idea,
 * because the same "the source failed, which is not an answer" argument applies
 * to our own Postgres - `playHistoryService.getYearOverview` used to render a
 * dropped connection as a year of zero plays. `name` and the message text are
 * unchanged, so `isLastFmUnavailable` and every `instanceof` keep working.
 */
import { SourceUnavailableError } from './sourceUnavailableError';

export class LastFmUnavailableError extends SourceUnavailableError {
  constructor(method: string, cause: unknown) {
    super(method, cause, 'Last.fm unavailable', 'LastFmUnavailableError');
  }
}

/** TRUE for this error specifically, safe across module instances. */
export const isLastFmUnavailable = (err: unknown): err is LastFmUnavailableError =>
  err instanceof Error && err.name === 'LastFmUnavailableError';
