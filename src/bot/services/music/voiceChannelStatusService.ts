import { Routes, type Client } from 'discord.js';
import { Logger } from '@domain/logger';
import { cleanArtistName, cleanTrackTitle } from '@domain/models/music/musicTrack';

export class VoiceChannelStatusService {
  private readonly client: Client;
  private readonly channelStatuses = new Map<string, string>();

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Sets the voice channel status to "Artist - Song Title".
   */
  public async setStatus(channelId: string, trackTitle: string, author?: string): Promise<boolean> {
    if (!channelId || !trackTitle?.trim()) return false;

    const cleanTitle = cleanTrackTitle(trackTitle, author).trim();
    if (!cleanTitle) return false;

    const cleanAuthor = author ? cleanArtistName(author).trim() : '';

    let formattedStatus: string;
    if (
      cleanAuthor &&
      cleanAuthor.toLowerCase() !== 'unknown artist' &&
      !cleanTitle.toLowerCase().includes(cleanAuthor.toLowerCase())
    ) {
      formattedStatus = `${cleanAuthor} - ${cleanTitle}`;
    } else {
      formattedStatus = cleanTitle;
    }

    // Truncate to Discord's maximum status length (500 chars)
    const statusText = formattedStatus.slice(0, 500);

    // Skip redundant network requests if already set
    if (this.channelStatuses.get(channelId) === statusText) {
      return true;
    }

    try {
      await this.client.rest.put(Routes.channelVoiceStatus(channelId), {
        body: { status: statusText },
      });
      this.channelStatuses.set(channelId, statusText);
      Logger.debug({ channelId, statusText }, '[VoiceStatus] Set voice channel status to song name');
      return true;
    } catch (err: unknown) {
      // Missing permissions (50013), rate limited (429), or not a voice channel (400)
      Logger.debug({ err, channelId }, '[VoiceStatus] Could not set voice channel status (missing permission or rate-limited)');
      return false;
    }
  }

  /**
   * Clears the voice channel status.
   */
  public async clearStatus(channelId: string): Promise<boolean> {
    if (!channelId) return false;

    if (!this.channelStatuses.has(channelId) || this.channelStatuses.get(channelId) === '') {
      return true;
    }

    try {
      await this.client.rest.put(Routes.channelVoiceStatus(channelId), {
        body: { status: '' },
      });
      this.channelStatuses.delete(channelId);
      Logger.debug({ channelId }, '[VoiceStatus] Cleared voice channel status');
      return true;
    } catch {
      this.channelStatuses.delete(channelId);
      return false;
    }
  }
}
