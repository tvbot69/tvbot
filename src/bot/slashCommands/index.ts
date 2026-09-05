import { container } from 'tsyringe';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import type { SlashCommandDefinition } from '@bot/models/commandModels';
import { UserSlashCommands } from './userSlashCommands';
import { StaticSlashCommands } from './staticSlashCommands';
import { ChartSlashCommands } from './chartSlashCommands';
import { LoginSlashCommands } from './loginSlashCommands';
import { SettingsSlashCommands } from './settingsSlashCommands';
import { AlbumSlashCommands } from './albumSlashCommands';
import { WhoKnowsSlashCommands } from './whoKnowsSlashCommands';
import { FriendSlashCommands } from './friendSlashCommands';
import { MusicSlashCommands } from './musicSlashCommands';
import { TrackSlashCommands } from './trackSlashCommands';
import { TopSlashCommands } from './topSlashCommands';
import { OverviewSlashCommands } from './overviewSlashCommands';
import { ArtistTrackSlashCommands } from './artistTrackSlashCommands';
import { UpdateSlashCommands } from './updateSlashCommands';
import { ArtistSlashCommands } from './artistSlashCommands';
import { TasteSlashCommands } from './tasteSlashCommands';
import { CrownSlashCommands } from './crownSlashCommands';
import { FootballSlashCommands } from './footballSlashCommands';

let commandCache: Map<string, SlashCommandDefinition> | null = null;

const buildCommands = (): Map<string, SlashCommandDefinition> => {
  const modules = [
    container.resolve(UserSlashCommands),
    container.resolve(StaticSlashCommands),
    container.resolve(ChartSlashCommands),
    container.resolve(LoginSlashCommands),
    container.resolve(SettingsSlashCommands),
    container.resolve(AlbumSlashCommands),
    container.resolve(WhoKnowsSlashCommands),
    container.resolve(FriendSlashCommands),
    container.resolve(MusicSlashCommands),
    container.resolve(TrackSlashCommands),
    container.resolve(TopSlashCommands),
    container.resolve(OverviewSlashCommands),
    container.resolve(ArtistTrackSlashCommands),
    container.resolve(UpdateSlashCommands),
    container.resolve(ArtistSlashCommands),
    container.resolve(TasteSlashCommands),
    container.resolve(CrownSlashCommands),
    container.resolve(FootballSlashCommands),
  ];
  const map = new Map<string, SlashCommandDefinition>();
  for (const module of modules) {
    for (const command of module.commands) {
      map.set(command.data.name, command);
    }
  }
  return map;
};

export const getSlashCommand = (name: string): SlashCommandDefinition | undefined => {
  if (!commandCache) {
    commandCache = buildCommands();
  }
  return commandCache.get(name.toLowerCase());
};

export const getSlashCommandPayloads = (): RESTPostAPIApplicationCommandsJSONBody[] => {
  if (!commandCache) {
    commandCache = buildCommands();
  }
  return [...commandCache.values()].map((c) => c.data.toJSON());
};
