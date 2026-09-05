import type { AutocompleteInteraction } from 'discord.js';
import type { IAutoCompleteHandler } from './iautoCompleteHandler';

export class ArtistAutoComplete implements IAutoCompleteHandler {
  public async handleAsync(interaction: AutocompleteInteraction): Promise<void> {
    await interaction.respond([]);
  }
}
