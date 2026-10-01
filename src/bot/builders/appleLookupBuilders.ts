import type { AppleMusicService } from '@bot/services/appleMusicService';
import { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { errorMessage } from '@domain/discordErrors';

/**
 * The Apple Music link lookups, resolved into a shape the command layer can
 * render without re-deciding what a failure means.
 *
 * This is the shared half of `.applemusic` / `/applemusic`, and it is shared
 * because it is RESPONSE behaviour, not argument parsing. The two families
 * genuinely diverge on how they read a query — typed options against a
 * hand-written string grammar — but they must agree on what happens when the
 * provider cannot be reached, or the same outage renders two different lies.
 *
 * WHY THREE STATES
 * ----------------
 * `miss` and `failed` both mean "no URL to give the user", but they are
 * different facts and they must not share a representation. `miss` means Apple
 * was asked and has nothing. `failed` means nobody managed to ask. Rendering
 * the second as the first is how a transient iTunes 503 became "No Apple Music
 * release found" — a catalogue claim the user had no way to distrust.
 *
 * `AppleMusicService` used to `return null` on a non-OK response, which made
 * the two indistinguishable at the call site. It raises `ITunesUnavailableError`
 * now, and these wrappers are what turn that raise into something a command can
 * return instead of letting it escape as Discord's generic failure.
 *
 * A discriminant rather than an optional `errorResponse`, because an optional
 * property on a union does not narrow: `'errorResponse' in item` left the
 * property typed `ResponseModel | undefined`, which is the same class of lie.
 */
export type AppleLookup =
  | { kind: 'found'; url: string }
  | { kind: 'miss' }
  | { kind: 'failed'; errorResponse: ResponseModel };

/** Which of the three lookups to make, for the message a failure produces. */
export type AppleLookupKind = 'track' | 'album' | 'artist';

const FAILURE_LABEL: Record<AppleLookupKind, string> = {
  track: 'Apple Music search',
  album: 'Apple Music album search',
  artist: 'Apple Music artist search',
};

/**
 * Run one Apple lookup and classify the outcome.
 *
 * `run` is passed in rather than a kind switched over here so the caller keeps
 * ownership of which service method to call, and so this function has exactly
 * one job: turn a promise that may raise into an `AppleLookup`.
 */
async function classify(
  kind: AppleLookupKind,
  run: () => Promise<string | null | undefined>,
): Promise<AppleLookup> {
  try {
    const url = await run();
    return url ? { kind: 'found', url } : { kind: 'miss' };
  } catch (err) {
    return {
      kind: 'failed',
      errorResponse: GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `${FAILURE_LABEL[kind]} failed: ${errorMessage(err) || 'Unknown error'}`,
      ),
    };
  }
}

/** Song lookup. A track with no `url` is a miss, not a half-result. */
export const appleSearchTrack = (
  service: AppleMusicService,
  query: string,
): Promise<AppleLookup> => classify('track', () => service.searchSong(query).then((i) => i?.url));

/** Album lookup. */
export const appleSearchAlbum = (
  service: AppleMusicService,
  query: string,
): Promise<AppleLookup> => classify('album', () => service.searchAlbum(query));

/** Artist lookup. */
export const appleSearchArtist = (
  service: AppleMusicService,
  query: string,
): Promise<AppleLookup> => classify('artist', () => service.searchArtist(query));