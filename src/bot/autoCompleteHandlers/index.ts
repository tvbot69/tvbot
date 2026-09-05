import type { AutocompleteInteraction } from 'discord.js';
import type { IAutoCompleteHandler } from './iautoCompleteHandler';
import { ArtistAutoComplete } from './artistAutoComplete';
import { ChartSizeAutoComplete } from './chartSizeAutoComplete';
import { DateTimeAutoComplete } from './dateTimeAutoComplete';

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
