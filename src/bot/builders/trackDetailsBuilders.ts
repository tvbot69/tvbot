import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';

import { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import { setPreview } from '@bot/services/audio/voiceMessageService';
import { EMOJI } from '@bot/resources/emojis';

// Must match final JSON exactly: "**TRACK** by **ARTIST** has `140.0` bpm, is in key `G#` and lasts `3:18`"
export class TrackDetailsBuilders {
  public static buildTrackDetailsResponse(details: Awaited<ReturnType<TrackDetailsService['getDetails']>>, uniqueId: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);

    // Store preview for button handler
    if (details.previewUrl) setPreview(uniqueId, details.previewUrl);

    let content: string;
    if (details.bpm !== null && details.key !== null) {
      const bpmStr = `${details.bpm.toFixed(1)}`;
      content = `**${details.trackName}** by **${details.artistName}** has \`${bpmStr}\` bpm, is in key \`${details.key}\` and lasts \`${details.durationFormatted}\``;
    } else if (details.durationMs > 0) {
      content = `**${details.trackName}** by **${details.artistName}** lasts \`${details.durationFormatted}\` (No Spotify track metadata found)`;
    } else {
      content = `**${details.trackName}** by **${details.artistName}** is a track that we don't have any metadata for, sorry <:Whiskeydogearnest:1097591075822129292>`;
    }

    // Use content field (not embed) to match final JSON {"content": "...", "components": [...]}
    response.setContent(content);

    // Row with Preview + Open on {Spotify|Deezer|Apple Music} — emoji per source
    const row = new ActionRowBuilder<ButtonBuilder>();

    const previewButton = new ButtonBuilder()
      .setCustomId(`track-preview:${uniqueId}:`)
      .setLabel('Preview')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(EMOJI.playPreview)
      .setDisabled(!details.previewUrl);
    row.addComponents(previewButton);

    // Source-aware store button — if source is spotify, button is Spotify even when spotifyUrl came from scraper storeUrl
    const source = details.resolved?.source;
    if (source === 'spotify' || details.spotifyUrl || details.storeUrl?.includes('spotify.com')) {
      const url = details.spotifyUrl ?? details.storeUrl!;
      row.addComponents(new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(url)
        .setLabel('Open on Spotify')
        .setEmoji(EMOJI.serviceSpotify));
    } else if (source === 'deezer' || details.storeUrl?.includes('deezer.com')) {
      row.addComponents(new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(details.storeUrl!)
        .setLabel('Open on Deezer')
        .setEmoji(EMOJI.serviceDeezer));
    } else if (details.storeUrl) {
      // Apple only. Every other recognised store was handled above, so a url that
      // reaches here is a store we cannot name. Labelling it "Open on Spotify"
      // with the Spotify emoji sends the user to a button that claims to be
      // something it is not; omitting it says less but never lies.
      const isApple = source === 'apple' || details.storeUrl.includes('apple.com') || details.storeUrl.includes('itunes');
      if (isApple) {
        row.addComponents(new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setURL(details.storeUrl)
          .setLabel('Open on Apple Music')
          .setEmoji(EMOJI.serviceAppleMusic));
      }
    }

    response.addButtonRow(0, row);

    return response;
  }

  public static buildNoMetadataResponse(artist: string, track: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.setContent(`**${track}** by **${artist}** is a track that we don't have any metadata for, sorry <:Whiskeydogearnest:1097591075822129292>`);
    return response;
  }
}
