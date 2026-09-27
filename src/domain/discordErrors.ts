/**
 * Reading the errors discord.js throws, without pretending they are typed.
 *
 * `rest.post(...).edit(...)` rejects with a `DiscordAPIError`, but the promise
 * type says `unknown` in strict mode - correctly, because a REST call can also
 * fail on the network, in the HTTP client, or on a rate-limit guard before
 * discord.js ever builds an error object. So every site that wants to branch on
 * `err.code === 10008` or `err.rawError.retry_after` has to probe the shape
 * itself.
 *
 * Three sites were each doing that with their own hand-written inline type and
 * their own ordering of the three places Discord hides `retry_after`. This
 * module makes it one place, and one set of rules.
 *
 * Deliberately NOT extending `DiscordAPIError`: these helpers accept
 * `unknown`, because the input genuinely is unknown, and a signature that lies
 * about its argument is how `as` casts get added back in one file at a time.
 */

/** The subset of Discord's HTTP error body this bot actually branches on. */
export interface DiscordErrorLike {
  code?: number;
  status?: number;
  message?: string;
  /** Set by `@discordjs/rest` rate-limit handling. */
  retryAfter?: number;
  /** Set by `RESTJSONErrorCodes` failures; carries the body verbatim. */
  rawError?: unknown;
  /** Some endpoints put the delay at the top level, in SECONDS. */
  retry_after?: number;
}

const asDiscordError = (err: unknown): DiscordErrorLike | null =>
  typeof err === 'object' && err !== null ? (err as DiscordErrorLike) : null;

const positiveNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/**
 * The message of an unknown thrown value, as a string, for logs and embeds.
 *
 * Replaces `${err.message}` and `String(err)`, which are both wrong in a way
 * that hides information: a thrown object renders as `[object Object]`, and a
 * `DiscordAPIError`'s message is usually just "Unknown Error" while the useful
 * detail sits in `rawError`.
 */
export const errorMessage = (err: unknown, maxLength = 500): string => {
  let text: string;
  try {
    text = describe(err);
  } catch {
    // Every property access above is a potential trap: a thrown value can carry
    // a getter that throws, and this function is called FROM catch blocks, so a
    // throw here would replace the original failure with an unrelated one and
    // lose the diagnostic entirely.
    text = Object.prototype.toString.call(err);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

const describe = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return String(err);

  const like = asDiscordError(err);
  const raw = like?.rawError;
  // A RESTJSONError's own message is routinely "Unknown Error", so prefer the
  // body when it carries something more specific.
  if (raw && typeof raw === 'object') {
    const rawMessage = (raw as { message?: unknown }).message;
    if (typeof rawMessage === 'string' && rawMessage) return rawMessage;
    return JSON.stringify(raw) ?? String(raw);
  }
  if (typeof like?.message === 'string' && like.message) return like.message;
  return JSON.stringify(err) ?? String(err);
};

/**
 * How long Discord asked us to wait, in MILLISECONDS.
 *
 * Discord puts this in three different places depending on which layer
 * rejected: `retryAfter` (ms, from @discordjs/rest), `rawError.retry_after`
 * (SECONDS, from the API body), and a bare `retry_after` (SECONDS). The
 * unit mismatch is the trap - reading `rawError.retry_after` as ms gives you a
 * 1000x-too-short wait and you hammer the endpoint anyway. That is why
 * AGENTS.md records "retry_after is honoured; a fixed 5s backoff is not", and
 * why this normalises once instead of at each call site.
 *
 * Returns 0 when there is no usable hint, so callers can use it as a boolean.
 */
export const discordRetryAfterMs = (err: unknown): number => {
  const like = asDiscordError(err);
  if (!like) return 0;

  const direct = positiveNumber(like.retryAfter);
  if (direct !== undefined) return direct;

  const raw = like.rawError;
  const rawSeconds =
    positiveNumber(asDiscordError(raw)?.retry_after) ?? positiveNumber(asDiscordError(raw)?.retryAfter);
  if (rawSeconds !== undefined) return rawSeconds * 1000;

  const topSeconds = positiveNumber(like.retry_after);
  if (topSeconds !== undefined) return topSeconds * 1000;

  return 0;
};

/** True for a rate-limit rejection, whatever layer produced it. */
export const isDiscordRateLimit = (err: unknown): boolean =>
  asDiscordError(err)?.status === 429 || discordRetryAfterMs(err) > 0;

/**
 * True for 10062 "Unknown interaction": the token expired, which happens on
 * every click more than 3s after the button rendered, and whenever the bot
 * lags. It is expected, not a failure, so callers downgrade it to DEBUG rather
 * than logging an ERROR for something no user can act on.
 *
 * The message check is a deliberate second path: some failures surface as a
 * plain `Error` whose text mentions the problem without carrying a code, and
 * those were previously string-matched at the call site anyway.
 */
export const isUnknownInteraction = (err: unknown): boolean => {
  const like = asDiscordError(err);
  return like?.code === 10062 || errorMessage(err, 200).includes('Unknown interaction');
};

/**
 * True only when the message is GONE, so retrying is provably pointless and
 * the caller should forget its cached message id.
 *
 * Deliberately narrow. An earlier draft also treated 50013 (Missing
 * Permissions) as terminal, which was wrong and was caught by an existing
 * test: the card publisher runs a BOUNDED retry specifically so that one
 * permission hiccup does not lose a chapter attach, and 50013 is the exact
 * case that retry exists for. Treating it as terminal silently deleted that
 * retry and the regression only showed up as "expected undefined to be 1".
 *
 * So this is "the message will never come back", not "the edit failed".
 * A permission error is a failure worth a few bounded attempts.
 */
export const isTerminalDiscordError = (err: unknown): boolean => {
  const like = asDiscordError(err);
  return like?.code === 10008 || like?.status === 404;
};

/**
 * True when a FETCH of an existing message cannot be recovered.
 *
 * Wider than isTerminalDiscordError on purpose, and the difference matters:
 * editing a message we already hold and fetching one we have lost are not the
 * same problem. A permission error on EDIT is worth a bounded retry (the card
 * publisher relies on that). A permission error on FETCH means we cannot see
 * the message at all, so there is nothing to retry into.
 */
export const isUnrecoverableMessageFetch = (err: unknown): boolean => {
  const like = asDiscordError(err);
  return like?.code === 10008 || like?.code === 50013 || like?.status === 404;
};
