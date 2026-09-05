import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { FootballService } from '@bot/services/football/footballService';
import { FootballBuilders } from '@bot/builders/footballBuilders';
import { SUPPORTED_LEAGUES } from '@domain/models/football/footballModels';

export class FootballSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(private readonly footballService: FootballService) {
    const leagueChoices = SUPPORTED_LEAGUES.slice(0, 25).map((l) => ({
      name: `${l.emoji} ${l.name}`,
      value: l.id,
    }));

    const dateChoices = [
      { name: '📅 Today', value: '0' },
      { name: 'Tomorrow ▶', value: '1' },
      { name: '◀ Yesterday', value: '-1' },
    ];

    const builder = new SlashCommandBuilder()
      .setName('matches')
      .setDescription('View football matches, live scores, and fixtures')
      .addStringOption((o) =>
        o
          .setName('league')
          .setDescription('Select a league')
          .setRequired(false)
          .addChoices(...leagueChoices)
      )
      .addStringOption((o) =>
        o
          .setName('date')
          .setDescription('Select a date (Today, Tomorrow, Yesterday)')
          .setRequired(false)
          .addChoices(...dateChoices)
      );

    this.commands = [
      {
        data: builder as any,
        executeAsync: (ctx) => this.matchesAsync(ctx),
      },
    ];
  }

  private async matchesAsync(ctx: ContextModel): Promise<ResponseModel> {
    const selectedLeagueId = ctx.interaction?.options.getString('league') ?? SUPPORTED_LEAGUES[0]!.id;
    const dateArg = ctx.interaction?.options.getString('date') ?? '0';
    const dateOffset = parseInt(dateArg, 10) || 0;

    const schedule = await this.footballService.getScheduleAsync(selectedLeagueId, dateOffset);
    return FootballBuilders.buildMatchesResponse(schedule, ctx.accentColor);
  }
}
