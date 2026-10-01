export interface Channel {
  channelId: string;
  guildId: string;
  toggledCommands: string[];
  whoKnowsWhitelisted: boolean;
  fmEmbedType?: number | null;
}
