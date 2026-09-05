export interface Guild {
  guildId: string;
  guildName: string;
  prefix?: string;
  guildCreatedOn: Date;
  lastCommand?: Date;
  commandsDisabled: boolean;
  emotesDisabled: boolean;
  accentColor?: number;
  fmEmbedType?: number | null;
  whoKnowsActivityThreshold?: number;
}
