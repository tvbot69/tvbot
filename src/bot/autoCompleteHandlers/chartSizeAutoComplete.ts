import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
} from 'discord.js';
import type { IAutoCompleteHandler } from './iautoCompleteHandler';

const allCombinations: string[] = [];
for (let i = 1; i <= 50; i++) {
  for (let j = 1; j <= 50 && i * j <= 100; j++) {
    allCombinations.push(`${i}x${j}`);
  }
}

const defaultSizes = ['3x3', '4x4', '5x5', '8x5', '10x10', '4x8'];

export class ChartSizeAutoComplete implements IAutoCompleteHandler {
  public async handleAsync(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true).value as string;
    let results: string[];

    if (!focused) {
      results = defaultSizes;
    } else {
      const search = focused.toLowerCase();
      results = [
        ...allCombinations.filter((c) => c.startsWith(search)).slice(0, 6),
        ...allCombinations.filter((c) => !c.startsWith(search) && c.includes(search)).slice(0, 5),
      ];
    }

    await interaction.respond(
      results.map((r) => ({ name: r, value: r }) as ApplicationCommandOptionChoiceData),
    );
  }
}
