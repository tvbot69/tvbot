import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
} from 'discord.js';
import type { IAutoCompleteHandler } from './iautoCompleteHandler';

const periodChoices = [
  { name: 'Weekly', value: 'weekly' },
  { name: 'Monthly', value: 'monthly' },
  { name: 'Quarterly', value: 'quarterly' },
  { name: 'Half yearly', value: 'halfyearly' },
  { name: 'Yearly', value: 'yearly' },
  { name: 'All time', value: 'overall' },
];

export class DateTimeAutoComplete implements IAutoCompleteHandler {
  public async handleAsync(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true).value as string;
    const search = focused.toLowerCase();

    const results = focused
      ? periodChoices.filter((p) => p.value.includes(search))
      : periodChoices;

    await interaction.respond(
      results.slice(0, 25).map((p) => p as ApplicationCommandOptionChoiceData),
    );
  }
}
