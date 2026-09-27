import { injectable, inject } from 'tsyringe';
import type { ButtonInteraction } from 'discord.js';
import { Logger } from '@domain/logger';
import { TrackBuilders } from '@bot/builders/trackBuilders';
import { TrackService } from '@bot/services/trackService';
import { LyricsService } from '@bot/services/music/lyricsService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { deferReplySafe, deferUpdateSafe } from './interactionAck';

@injectable()
export class NowPlayingInteractions {
  constructor(
    @inject(UserRepository) private readonly userRepository: UserRepository,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(TrackService) private readonly trackService: TrackService,
    @inject(LyricsService) private readonly lyricsService?: LyricsService,
  ) {}

  /**
   * Handle 1-click scrobble interaction: scrobble-ref:{token} or scrobble-now:{artist}:{track}
   */
  public async handleScrobble(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    // Ack before any DB work — past 2.5s the global ack guard defers and a
    // late reply() throws, leaving the press answerless.
    await deferReplySafe(interaction, { ephemeral: true });
    const user = await this.userRepository.getUserByDiscordUserId(interaction.user.id);

    if (!user || !user.userNameLastFm) {
      await interaction.editReply({
        content: '❌ You must link your Last.fm account before you can scrobble. Use `/login` or `.register <username>`.',
      });
      return;
    }

    if (!user.sessionKey) {
      await interaction.editReply({
        content: '❌ Your Last.fm session key is missing. Please log in using `/login` to authorize scrobbling.',
      });
      return;
    }

    let artist = '';
    let track = '';

    if (customId.startsWith('scrobble-ref:')) {
      const refToken = customId.replace('scrobble-ref:', '').split(':')[0]!;
      const ref = this.trackService.getScrobbleReference(refToken);
      if (!ref) {
        await interaction.editReply({
          content: '⚠️ This scrobble button reference has expired. Please use `.fm` to load the current track.',
        });
        return;
      }
      artist = ref.artist;
      track = ref.track;
    } else if (customId.startsWith('scrobble-now:')) {
      const parts = customId.replace('scrobble-now:', '').split(':');
      artist = decodeURIComponent(parts[0] || '');
      track = decodeURIComponent(parts[1] || '');
    }

    if (!artist || !track) {
      await interaction.editReply({
        content: '❌ Invalid track scrobble reference.',
      });
      return;
    }

    try {
      const scrobbled = await this.lastfmRepository.scrobbleTrack(
        artist,
        track,
        Math.floor(Date.now() / 1000),
        user.sessionKey,
      );
      if (!scrobbled) {
        await interaction.editReply({
          content: '❌ Last.fm rejected the scrobble. Your session may have expired — try `/login` again.',
        });
        return;
      }

      const res = TrackBuilders.buildScrobbleResponse(track, artist, user.userNameLastFm);
      await interaction.editReply({
        content: res.componentsV2Container ? undefined : `✅ Scrobbled **${track}** by **${artist}** to your Last.fm!`,
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
      });
    } catch (err: any) {
      Logger.warn({ err: err?.message }, `[NowPlayingInteractions] Scrobble failed for ${user.userNameLastFm}`);
      await interaction.editReply({
        content: '❌ Could not reach Last.fm. Please try again in a moment.',
      });
    }
  }

  /**
   * Handle 1-click love / unlove: love-track:{artist}:{track} or unlove-track:{artist}:{track}
   */
  public async handleLove(interaction: ButtonInteraction): Promise<void> {
    const isUnlove = interaction.customId.startsWith('unlove-track:');
    const prefix = isUnlove ? 'unlove-track:' : 'love-track:';
    const parts = interaction.customId.replace(prefix, '').split(':');
    const artist = decodeURIComponent(parts[0] || '');
    const track = decodeURIComponent(parts[1] || '');

    await deferReplySafe(interaction, { ephemeral: true });
    const user = await this.userRepository.getUserByDiscordUserId(interaction.user.id);

    if (!user || !user.userNameLastFm) {
      await interaction.editReply({
        content: '❌ Please link your Last.fm account with `/login` or `.register <username>` to love tracks.',
      });
      return;
    }

    if (!user.sessionKey) {
      await interaction.editReply({
        content: '❌ Session key required to update loved tracks. Please authorize with `/login`.',
      });
      return;
    }

    try {
      // The repository swallows provider errors and returns false, so the
      // result MUST be checked: reporting "Loved" for a rejected write (an
      // expired session key is the common case) is worse than no button.
      const loved = isUnlove
        ? await this.lastfmRepository.unloveTrack(artist, track, user.sessionKey)
        : await this.lastfmRepository.loveTrack(artist, track, user.sessionKey);
      if (!loved) {
        await interaction.editReply({
          content: `❌ Last.fm rejected the ${isUnlove ? 'unlove' : 'love'}. Your session may have expired — try \`/login\` again.`,
        });
        return;
      }
      await interaction.editReply({
        content: isUnlove
          ? `💔 Unloved **${track}** by **${artist}** on Last.fm.`
          : `❤️ Loved **${track}** by **${artist}** on Last.fm.`,
      });
    } catch (err: any) {
      Logger.warn({ err: err?.message }, `[NowPlayingInteractions] Love/Unlove failed for ${user.userNameLastFm}`);
      // Fixed copy: raw provider messages ("Last.fm returned HTTP 403") read
      // as internal plumbing leaking at the user.
      await interaction.editReply({
        content: '❌ Could not reach Last.fm. Please try again in a moment.',
      });
    }
  }

  /**
   * Handle lyrics button: track-lyrics:{artist}:{track}:fm
   */
  public async handleLyrics(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.replace('track-lyrics:', '').split(':');
    const artist = decodeURIComponent(parts[0] || '');
    const track = decodeURIComponent(parts[1] || '');

    if (!this.lyricsService) {
      await interaction.reply({
        content: '❌ Lyrics service is temporarily unavailable.',
        ephemeral: true,
      });
      return;
    }

    await deferReplySafe(interaction, { ephemeral: true });

    try {
      const result = await this.lyricsService.getLyrics(track, artist);
      if (!result || !result.plainLyrics) {
        await interaction.editReply({
          content: `No lyrics found for **${track}** by **${artist}**.`,
        });
        return;
      }

      const res = TrackBuilders.buildTrackLyricsResponse(
        result.title,
        result.artist,
        result.plainLyrics,
        result.source === 'genius' ? 'https://genius.com' : undefined,
      );

      await interaction.editReply({
        components: res.componentsV2Container ? [res.componentsV2Container] : [],
        content: res.componentsV2Container ? undefined : `### Lyrics for **${result.title}** by **${result.artist}**\n\n${result.plainLyrics.slice(0, 1900)}`,
      });
    } catch (err: any) {
      Logger.warn({ err: err?.message }, '[NowPlayingInteractions] Lyrics lookup failed');
      // Fixed copy: a raw provider message ("HTTP 403 from lyrics provider")
      // reads as internal plumbing leaking at the user.
      await interaction.editReply({
        content: '❌ Could not load lyrics for that track. Try again in a moment.',
      });
    }
  }

  /**
   * Handle loved tracks pagination: loved:prev:{page}:{username} or loved:next:{page}:{username}
   */
  public async handleLovedPagination(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    const dir = parts[1];
    const currentPage = parseInt(parts[2] || '0', 10);
    const userNameLastFm = decodeURIComponent(parts[3] || '');

    if (!userNameLastFm) return;

    const newPage = dir === 'prev' ? Math.max(0, currentPage - 1) : currentPage + 1;

    await deferUpdateSafe(interaction);

    try {
      const user = await this.userRepository.getUserByDiscordUserId(interaction.user.id);
      const sessionKey = user?.userNameLastFm?.toLowerCase() === userNameLastFm.toLowerCase() ? user?.sessionKey : undefined;

      const { tracks, total } = await this.lastfmRepository.getLovedTracks(userNameLastFm, 200, 1, sessionKey);
      const displayName = interaction.guild?.members.cache.get(interaction.user.id)?.displayName ?? userNameLastFm;

      const res = TrackBuilders.buildLovedTracksResponse(
        userNameLastFm,
        displayName,
        tracks,
        newPage,
        total,
      );

      if (res.componentsV2Container) {
        await interaction.editReply({
          components: [res.componentsV2Container],
        });
      }
    } catch (err: any) {
      Logger.warn({ err: err?.message }, `[NowPlayingInteractions] handleLovedPagination error for ${userNameLastFm}`);
    }
  }
}
