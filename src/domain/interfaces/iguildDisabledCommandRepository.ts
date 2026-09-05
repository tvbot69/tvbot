import type { GuildDisabledCommand } from '@persistence/domain/models/guildDisabledCommand';

export interface IGuildDisabledCommandRepository {
  getAllForGuild(guildId: string): Promise<GuildDisabledCommand[]>;
  add(guildId: string, commandName: string): Promise<void>;
  remove(guildId: string, commandName: string): Promise<void>;
}
