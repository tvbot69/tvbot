import type { AutocompleteInteraction } from 'discord.js';
import type { IAutoCompleteHandler } from '@bot/autoCompleteHandlers/iautoCompleteHandler';
import { ArtistAutoComplete } from '@bot/autoCompleteHandlers/artistAutoComplete';
import { ChartSizeAutoComplete } from '@bot/autoCompleteHandlers/chartSizeAutoComplete';
import { DateTimeAutoComplete } from '@bot/autoCompleteHandlers/dateTimeAutoComplete';

const handlers: Record<string, IAutoCompleteHandler> = {
  artist: new ArtistAutoComplete(),
  size: new ChartSizeAutoComplete(),
  'time-period': new DateTimeAutoComplete(),
};

export const getAutoCompleteResponder = (
  focusedOptionName: string,
): ((interaction: AutocompleteInteraction) => Promise<void>) | undefined => {
  const handler = handlers[focusedOptionName];
  if (!handler) {
    return undefined;
  }
  return (interaction) => handler.handleAsync(interaction);
};
