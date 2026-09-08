export interface Guild {
  guildId: string;
  guildName: string;
  prefix?: string;
  guildCreatedOn: Date;
  lastCommand?: Date;
  commandsDisabled: boolean;
  emotesDisabled: boolean;
  fmEmbedType?: number | null;
  whoKnowsActivityThreshold?: number;
  crownsDisabled?: boolean;
  crownsMinimumPlaycountThreshold?: number | null;
  crownsActivityThresholdDays?: number | null;
  crownRoles?: string[];
}
