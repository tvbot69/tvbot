import type { AutocompleteInteraction } from 'discord.js';

export interface IAutoCompleteHandler {
  handleAsync(interaction: AutocompleteInteraction): Promise<void>;
}
