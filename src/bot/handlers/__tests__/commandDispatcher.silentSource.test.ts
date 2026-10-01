/**
 * The TEXT command boundary could not tell an outage from a defect.
 *
 * `CommandDispatcher.handleCommandException` is where a throw from a text
 * command lands, and it had exactly one message for every failure:
 *
 *     Sorry, something went wrong while executing that command.
 *     Please try again later.
 *
 * That sentence is wrong twice over for a `SourceUnavailableError`. It asks the
 * user to retry a command that will fail identically while the source is down,
 * and it reads - to the user AND to whoever reads the log line the reference id
 * points at - as a bug rather than the known, self-cancelling condition the
 * error type exists to describe. The component boundary was fixed for this in
 * the last commit (`interactionHandler.onInteractionCreated`); this one was
 * missed, and the repo says so itself at `tasteCommands.ts:108`, which wraps
 * `getTasteData` in a catch *because* this function does not name the source.
 *
 * BOTH DIRECTIONS. Pinning only the new branch would pass just as happily
 * against a blanket `SourceUnavailableError || true` - i.e. against a boundary
 * that reports "could not reach the database" for a genuine defect, which is
 * worse than what it replaced because it tells the user retrying will never
 * work. So each of the three outcomes is pinned: a source outage names the
 * source, a plain defect keeps the generic text, and the "missing permissions"
 * string match - an older, blunter heuristic - still wins for its own case.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CommandDispatcher } from '../commandDispatcher';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';

const LFM_DOWN = (method: string): LastFmUnavailableError =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 503'));

const DB_DOWN = (method: string): SourceUnavailableError =>
  new SourceUnavailableError(method, new Error('connect ECONNREFUSED 10.0.0.5:5432'), 'Database unavailable');

const makeMessage = () => {
  // The payload parameter is declared so `mock.calls[0][0]` typechecks: a
// zero-arg mock infers a `[]` call tuple, and reading index 0 of it is a
// compile error that reads as nothing at all under vitest.
const send = vi.fn(async (..._args: unknown[]) => ({ id: 'sent-1' }));
  const message = {
    content: '.inprogress',
    guildId: 'g1',
    guild: { name: 'Test Guild' },
    author: { id: 'u1', username: 'tester', tag: 'tester#0001' },
    channel: { send },
  };
  return { message: message as never, send };
};

/** The description of the single embed the boundary sent. */
const apology = (send: ReturnType<typeof vi.fn>): string => {
  const payload = send.mock.calls[0]![0] as { embeds: Array<{ toJSON: () => { description: string } }> };
  return payload.embeds[0]!.toJSON().description;
};

describe('CommandDispatcher.handleCommandException — a source outage is named, not generic', () => {
  it('names Last.fm when a Last.fm read raised', async () => {
    const { message, send } = makeMessage();

    await CommandDispatcher.handleCommandException(LFM_DOWN('lastFmRepository.getRecentTracks'), message, 'inprogress');

    const text = apology(send);
    expect(text).toContain('Could not reach Last.fm');
    expect(text).toContain('try again in a moment');
    expect(text).not.toMatch(/something went wrong/i);
  });

  it('names the database when our own Postgres raised', async () => {
    const { message, send } = makeMessage();

    await CommandDispatcher.handleCommandException(DB_DOWN('playRepository.getUserPlays'), message, 'top');

    const text = apology(send);
    expect(text).toContain('Could not reach the database');
    expect(text).not.toMatch(/something went wrong/i);
  });

  it('still keeps a reference id on a source failure, so the outage is traceable', async () => {
    const { message, send } = makeMessage();

    await CommandDispatcher.handleCommandException(LFM_DOWN('lastFmRepository.getTopArtists'), message, 'top');

    expect(apology(send)).toMatch(/Reference ID: `\w+`/);
  });

  it('does NOT turn a genuine defect into a source failure', async () => {
    // The other half of the pair. "Could not reach the database. Try again in a
    // moment" on a NullPointerException is a worse lie than the generic text,
    // because it tells the user their retry is futile and hides the defect.
    const { message, send } = makeMessage();

    await CommandDispatcher.handleCommandException(new TypeError("Cannot read properties of undefined"), message, 'top');

    const text = apology(send);
    expect(text).toMatch(/something went wrong while executing that command/i);
    expect(text).not.toMatch(/could not reach/i);
  });

  it('keeps the missing-permissions message for a permissions failure', async () => {
    // A third outcome, and the reason the source branch is checked FIRST: a
    // typed error outranks a substring match on its cause, but a plain error
    // that merely CONTAINS "missing permissions" must still read as a
    // permissions problem, or the fix would cost that user the instruction that
    // tells them how to fix it.
    const { message, send } = makeMessage();

    await CommandDispatcher.handleCommandException(new Error('Missing Permissions in Test Guild'), message, 'top');

    const text = apology(send);
    expect(text).toMatch(/missing permissions/i);
    // The whole line, closing punctuation included: adding the branch above put
    // the source and permissions messages side by side, and dropping the
    // trailing `*` from this one is invisible to a `/missing permissions/i`.
    expect(text).toContain('*Reference ID: `');
    expect(text.endsWith('*')).toBe(true);
  });

  it('does not mistake a source failure for a permissions failure', async () => {
    // The mirror of the previous test: the source branch runs first, so an
    // outage whose cause text happens to mention permissions still reports the
    // source, which is the thing that can be retried.
    const { message, send } = makeMessage();
    const err = new SourceUnavailableError(
      'lastFmRepository.getAlbumInfo',
      new Error('HTTP 403 missing permissions for this stream'),
      'Last.fm unavailable',
      'LastFmUnavailableError',
    );

    await CommandDispatcher.handleCommandException(err, message, 'album');

    expect(apology(send)).toMatch(/could not reach/i);
  });

  it('still sends exactly one message, ephemerally-addressed and mention-free', async () => {
    const { message, send } = makeMessage();

    await CommandDispatcher.handleCommandException(DB_DOWN('playRepository.getYearOverview'), message, 'year');

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0] as { allowedMentions: { parse: string[] } };
    expect(payload.allowedMentions.parse).toEqual([]);
  });

  it('does not throw when the error is not an Error at all', async () => {
    // A rejected promise carrying a string is still a command failure; the
    // boundary must answer it rather than trip over `instanceof`.
    const { message, send } = makeMessage();

    await expect(
      CommandDispatcher.handleCommandException('something odd', message, 'top'),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
