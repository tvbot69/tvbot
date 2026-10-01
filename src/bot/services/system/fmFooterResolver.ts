import { container } from 'tsyringe';
import { Logger } from '@domain/logger';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import { ArtistsService } from '../artistsService';
import { AlbumService } from '../albumService';
import { TrackService } from '../trackService';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { FmFooterRepository } from '@persistence/repositories/fmFooterRepository';

export interface FmFooterData {
  artistPlays?: number;
  albumPlays?: number;
  trackPlays?: number;
  artistPlaysThisWeek?: number;
  serverArtistListeners?: number;
  serverAlbumListeners?: number;
  serverTrackListeners?: number;
  isLoved?: boolean;
  crownHolder?: string | null;
}

/**
 * Says out loud which footer clause a failed task cost the user.
 *
 * The candidate fields are intersected with what the result actually holds
 * because a task can half-succeed: task 3 resolves `isLoved` off the service
 * *before* its database fallback runs, so a fallback failure costs `trackPlays`
 * alone. Naming both there would be a second, smaller lie - in the log, which is
 * the only place this failure is currently visible.
 *
 * ERROR rather than WARN: a footer clause that cannot be read is a lost
 * capability on the most-watched card in the bot, and it is the level every
 * other "this query did not answer" site in this repo uses (see
 * `orDatabaseUnavailable` in `playHistoryService`, and `trackService`'s
 * `getLastMonthPlays`).
 */
const reportFieldFailure = (
  result: FmFooterData,
  fields: Array<keyof FmFooterData>,
  err: unknown,
): void => {
  // The `|| fields.join` fallback covers a task that failed before writing
  // anything, which is the normal case; the filter only ever narrows it.
  const lost = fields.filter(f => result[f] === undefined).join(' + ') || fields.join(' + ');
  Logger.error(
    { err: (err as Error)?.message ?? String(err), footerFields: lost },
    `Now-playing footer: could not read ${lost} - that clause is omitted from the card`,
  );
};

/**
 * Assembles the now-playing footer: up to nine optional fields, read in
 * parallel, each guarded by its own `FmFooterOption` bit.
 *
 * ## Why a failed read is logged here and NOT raised
 *
 * The A1 rule is that code which cannot read the database must say so instead
 * of answering with a plausible wrong number. Every task below honours the
 * first half and deliberately stops short of the second, because at THIS call
 * site a throw is the worse lie in the other direction:
 *
 *  - `footerBuilder.ts` renders a clause only when the field is present
 *    (`opts.artistPlays !== undefined`, and the same shape for the other
 *    eight), so an absent field is a *silently omitted* clause rather than a
 *    confident zero. There is no "could not load" affordance to render into,
 *    and inventing one means changing the builder and the `FmFooterData` shape
 *    that both callers spread straight into `buildFmResponse`.
 *  - Both callers - `playCommands.fmAsync` and `userSlashCommands.fmAsync` -
 *    await this and then build the card on the very next statement, with no
 *    local try/catch. A throw skips `buildFmResponse` entirely and lands in
 *    `commandDispatcher.handleCommandException`, which replies "Sorry,
 *    something went wrong while executing that command". A user who just
 *    scrobbled would get an apology instead of their own Now Playing card: a
 *    total loss where today they get the card with one clause missing.
 *
 * So each catch records the failure at ERROR, naming the exact fields it cost,
 * and the card is built without them. What is deliberately NOT done here - the
 * part of A1 that this file alone cannot close - is a rendered "unavailable"
 * marker. That needs a new field on `FmFooterData` plus a branch in
 * `footerBuilder`, and until some caller reads it, adding one would be a field
 * that looks protective and is not.
 *
 * Unchanged by this: a query that RAN and found nothing still leaves its field
 * absent. Empty stays empty; only a throw is reported.
 *
 * The `container.resolve` calls stay inside the tasks on purpose. Hoisting one
 * would let an unusable dependency throw *outside* the per-task catch, which is
 * the failure mode these catches exist to contain.
 */
export class FmFooterResolver {
  private static readonly NON_SCROBBLE_MASK =
    BigInt(FmFooterOption.Loved) |
    BigInt(FmFooterOption.ArtistPlays) |
    BigInt(FmFooterOption.AlbumPlays) |
    BigInt(FmFooterOption.TrackPlays) |
    BigInt(FmFooterOption.ArtistPlaysThisWeek) |
    BigInt(FmFooterOption.ServerArtistListeners) |
    BigInt(FmFooterOption.ServerAlbumListeners) |
    BigInt(FmFooterOption.ServerTrackListeners) |
    BigInt(FmFooterOption.CrownHolder);

  public static async resolveFooterData(
    user: User,
    track: RecentTrack | null | undefined,
    footerOptions: bigint,
    guildId?: string | null,
  ): Promise<FmFooterData> {
    if (!track || !track.artistName) {
      return {};
    }

    if ((footerOptions & this.NON_SCROBBLE_MASK) === BigInt(0)) {
      return {};
    }

    const has = (f: FmFooterOption) => (footerOptions & BigInt(f)) !== BigInt(0);
    const result: FmFooterData = {};
    const tasks: Promise<void>[] = [];

    // 1. Artist plays
    if (has(FmFooterOption.ArtistPlays)) {
      tasks.push(
        (async () => {
          try {
            // CORRECT AS IS: the failure leaves `artistPlays` undefined, which
            // `footerBuilder` omits - it never becomes a rendered 0. Class doc.
            const artistsService = container.resolve(ArtistsService);
            const info = await artistsService.getArtistInfo(track.artistName, user.userNameLastFm);
            if (info?.userPlayCount !== undefined) {
              result.artistPlays = info.userPlayCount;
            } else {
              const footerRepo = container.resolve(FmFooterRepository);
              const total = (await footerRepo.getUserArtistPlaycount(user.userId, track.artistName)) ?? 0;
              if (total > 0) result.artistPlays = total;
            }
          } catch (err) {
            // Either the service read or the `user_artists` aggregate behind it
            // failed. Logged, not raised: the footer drops the "N artist plays"
            // clause and every other clause is still right. A raise here would
            // cost the user the whole card - see the class doc.
            reportFieldFailure(result, ['artistPlays'], err);
          }
        })(),
      );
    }

    // 2. Album plays
    if (has(FmFooterOption.AlbumPlays) && track.albumName) {
      tasks.push(
        (async () => {
          try {
            // CORRECT AS IS: as task 1 - an undefined field is an omitted
            // clause, not a 0, and the `?? 0` below cannot leak either because
            // the assignment is gated on `total > 0`. Class doc.
            const albumService = container.resolve(AlbumService);
            const info = await albumService.getAlbumInfo(track.artistName, track.albumName!, user.userNameLastFm);
            if (info?.userPlayCount !== undefined) {
              result.albumPlays = info.userPlayCount;
            } else {
              const footerRepo = container.resolve(FmFooterRepository);
              const total = (await footerRepo.getUserAlbumPlaycount(user.userId, track.albumName)) ?? 0;
              if (total > 0) result.albumPlays = total;
            }
          } catch (err) {
            // Same shape as task 1, for the album. Logged, not raised: the
            // "N album plays" clause is dropped, the card survives.
            reportFieldFailure(result, ['albumPlays'], err);
          }
        })(),
      );
    }

    // 3. Track plays & Loved
    if (has(FmFooterOption.TrackPlays) || has(FmFooterOption.Loved)) {
      tasks.push(
        (async () => {
          try {
            // CORRECT AS IS: as task 1 - whichever of `trackPlays` / `isLoved`
            // had not been written yet stays absent. The love badge is
            // presence-gated (`footerBuilder.ts:23` tests truthiness, never
            // `!== undefined`) and has a second source in `opts.track.loved`
            // from the recent-track payload, so an absent flag drops a badge or
            // falls back to that. It never renders a false "not loved". Class doc.
            const trackService = container.resolve(TrackService);
            const info = await trackService.getTrackInfo(track.name, track.artistName, user.userNameLastFm);
            if (info) {
              if (info.userPlayCount !== undefined) {
                result.trackPlays = info.userPlayCount;
              }
              if (info.userLoved !== undefined) {
                result.isLoved = info.userLoved;
              }
            }
            if (result.trackPlays === undefined && has(FmFooterOption.TrackPlays)) {
              const footerRepo = container.resolve(FmFooterRepository);
              const total = (await footerRepo.getUserTrackPlaycount(user.userId, track.name)) ?? 0;
              if (total > 0) result.trackPlays = total;
            }
          } catch (err) {
            // The shared Loved/TrackPlays lookup. Logged, not raised, and the
            // field list is filtered against the result, so a failure *after*
            // `isLoved` landed is reported as `trackPlays` alone - which is
            // exactly what the user lost. The coupling itself is unchanged:
            // one service call still answers both flags.
            reportFieldFailure(result, ['trackPlays', 'isLoved'], err);
          }
        })(),
      );
    }

    // 4. Artist plays this week
    if (has(FmFooterOption.ArtistPlaysThisWeek)) {
      tasks.push(
        (async () => {
          try {
            const footerRepo = container.resolve(FmFooterRepository);
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            result.artistPlaysThisWeek = await footerRepo.countUserArtistPlaysSince(
              user.userId,
              track.artistName,
              weekAgo,
            );
          } catch (err) {
            // A `user_plays` count. Logged, not raised: the "N this week"
            // clause is dropped. Worth being precise about why this one is not
            // raised - a 0 here IS rendered, so the failure is a missing clause
            // rather than a false "0", and the rest of the card is unaffected.
            reportFieldFailure(result, ['artistPlaysThisWeek'], err);
          }
        })(),
      );
    }

    // 5. Server Artist listeners
    if (has(FmFooterOption.ServerArtistListeners) && guildId) {
      tasks.push(
        (async () => {
          try {
            const whoKnowsRepo = container.resolve(WhoKnowsRepository);
            const rows = await whoKnowsRepo.getIndexedUsersForArtist(guildId, track.artistName);
            result.serverArtistListeners = rows.filter((r) => r.playcount > 0).length;
          } catch (err) {
            // The who-knows rollup read. Logged, not raised: the
            // "N server listeners" clause is dropped. A raise would delete the
            // entire Now Playing card over one decoration clause.
            reportFieldFailure(result, ['serverArtistListeners'], err);
          }
        })(),
      );
    }

    // 6. Server Album listeners
    if (has(FmFooterOption.ServerAlbumListeners) && guildId && track.albumName) {
      tasks.push(
        (async () => {
          try {
            const footerRepo = container.resolve(FmFooterRepository);
            const album = await footerRepo.findAlbumByNameAndArtist(track.albumName, track.artistName);
            if (album) {
              const whoKnowsRepo = container.resolve(WhoKnowsRepository);
              const rows = await whoKnowsRepo.getIndexedUsersForAlbum(guildId, album.albumId);
              result.serverAlbumListeners = rows.filter((r) => r.playcount > 0).length;
            }
          } catch (err) {
            // Either the catalogue `albums` lookup or the who-knows read behind
            // it failed. Logged, not raised: the "N server album listeners"
            // clause is dropped.
            reportFieldFailure(result, ['serverAlbumListeners'], err);
          }
        })(),
      );
    }

    // 7. Server Track listeners
    if (has(FmFooterOption.ServerTrackListeners) && guildId) {
      tasks.push(
        (async () => {
          try {
            const footerRepo = container.resolve(FmFooterRepository);
            const dbTrack = await footerRepo.findTrackByNameAndArtist(track.name, track.artistName);
            if (dbTrack) {
              const whoKnowsRepo = container.resolve(WhoKnowsRepository);
              const rows = await whoKnowsRepo.getIndexedUsersForTrack(guildId, dbTrack.trackId);
              result.serverTrackListeners = rows.filter((r) => r.playcount > 0).length;
            }
          } catch (err) {
            // Same shape as task 6, for the track. Logged, not raised.
            reportFieldFailure(result, ['serverTrackListeners'], err);
          }
        })(),
      );
    }

    // 8. Crown holder
    if (has(FmFooterOption.CrownHolder) && guildId) {
      tasks.push(
        (async () => {
          try {
            const crownRepo = container.resolve(CrownRepository);
            const crown = await crownRepo.getCurrentCrown(guildId, track.artistName);
            if (crown?.userNameLastFm) {
              result.crownHolder = crown.userNameLastFm;
            }
          } catch (err) {
            // The `user_crowns` read. Logged, not raised. A missing crown
            // clause is the most plausible-wrong of the eight (the user cannot
            // tell "nobody holds it" from "we could not check"), which is why
            // it is logged by name rather than dropped without a word - but
            // raising would still cost the whole card for one clause.
            reportFieldFailure(result, ['crownHolder'], err);
          }
        })(),
      );
    }

    await Promise.all(tasks);
    return result;
  }
}
