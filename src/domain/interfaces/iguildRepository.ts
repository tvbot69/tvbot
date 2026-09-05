import type { Guild } from '@persistence/domain/models/guild';

export interface IGuildRepository {
  getGuild(guildId: string): Promise<Guild | null>;
  addOrUpdateGuild(guildId: string, guildName: string): Promise<Guild>;
  setPrefix(guildId: string, prefix: string | null): Promise<void>;
  setAccentColor(guildId: string, color: number | null): Promise<void>;
  setFmEmbedType(guildId: string, fmEmbedType: number | null): Promise<void>;
  setCommandsDisabled(guildId: string, disabled: boolean): Promise<void>;
  setLastCommand(guildId: string, date: Date): Promise<void>;
}
