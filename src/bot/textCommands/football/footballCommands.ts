import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { FootballService } from '@bot/services/football/footballService';
import { FootballBuilders } from '@bot/builders/footballBuilders';
import { findLeagueByQuery, SUPPORTED_LEAGUES } from '@domain/models/football/footballModels';

export class FootballCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(private readonly footballService: FootballService) {
    this.commands = [
      {
        name: 'matches',
        aliases: ['football', 'm', 'fixture', 'fixtures', 'match'],
        executeAsync: (ctx, args) => this.matchesAsync(ctx, args),
      },
    ];
  }

  private async matchesAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    let dateOffset = 0;
    let targetLeague = SUPPORTED_LEAGUES[0]!; // Default to Premier League

    const remainingArgs: string[] = [];

    for (const arg of args) {
      const lower = arg.toLowerCase().trim();
      if (['tomorrow', 'tmrw', 'tomo', '+1'].includes(lower)) {
        dateOffset = 1;
      } else if (['yesterday', 'yest', '-1'].includes(lower)) {
        dateOffset = -1;
      } else if (['today', '0'].includes(lower)) {
        dateOffset = 0;
      } else {
        remainingArgs.push(arg);
      }
    }

    if (remainingArgs.length > 0) {
      const query = remainingArgs.join(' ');
      const matched = findLeagueByQuery(query);
      if (matched) {
        targetLeague = matched;
      }
    }

    const schedule = await this.footballService.getScheduleAsync(targetLeague.id, dateOffset);
    return FootballBuilders.buildMatchesResponse(schedule, ctx.accentColor);
  }
}
