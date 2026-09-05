import { container } from 'tsyringe';
import type { TextCommandDefinition } from '@bot/models/commandModels';
import { PlayCommands } from './lastfm/playCommands';
import { StaticCommands } from './staticCommands';
import { ChartCommands } from './lastfm/chartCommands';
import { LoginCommands } from './lastfm/loginCommands';
import { SettingsCommands } from './settingsCommands';
import { AlbumCommands } from './lastfm/albumCommands';
import { WhoKnowsCommands } from './guild/whoKnowsCommands';
import { FriendsCommands } from './lastfm/friendsCommands';
import { MusicCommands } from './music/musicCommands';
import { TrackCommands } from './lastfm/trackCommands';
import { TopCommands } from './lastfm/topCommands';
import { OverviewCommands } from './lastfm/overviewCommands';
import { ArtistTrackCommands } from './lastfm/artistTrackCommands';
import { UpdateCommands } from './lastfm/updateCommands';
import { ArtistCommands } from './lastfm/artistCommands';
import { TasteCommands } from './lastfm/tasteCommands';
import { CrownCommands } from './guild/crownCommands';
import { FootballCommands } from './football/footballCommands';
import { PlaycountCommands } from './lastfm/playcountCommands';
import { ProfileCommands } from './lastfm/profileCommands';
import { StreakCommands } from './lastfm/streakCommands';
import { LibrarySearchCommands } from './lastfm/librarySearchCommands';
import { ServerCommands } from './guild/serverCommands';

let commandCache: Map<string, TextCommandDefinition> | null = null;

const buildCommands = (): Map<string, TextCommandDefinition> => {
  const modules = [
    container.resolve(PlayCommands),
    container.resolve(PlaycountCommands),
    container.resolve(ProfileCommands),
    container.resolve(StreakCommands),
    container.resolve(LibrarySearchCommands),
    container.resolve(ServerCommands),
    container.resolve(StaticCommands),
    container.resolve(ChartCommands),
    container.resolve(LoginCommands),
    container.resolve(SettingsCommands),
    container.resolve(AlbumCommands),
    container.resolve(WhoKnowsCommands),
    container.resolve(FriendsCommands),
    container.resolve(MusicCommands),
    container.resolve(TrackCommands),
    container.resolve(TopCommands),
    container.resolve(OverviewCommands),
    container.resolve(ArtistTrackCommands),
    container.resolve(UpdateCommands),
    container.resolve(ArtistCommands),
    container.resolve(TasteCommands),
    container.resolve(CrownCommands),
    container.resolve(FootballCommands),
  ];
  const map = new Map<string, TextCommandDefinition>();
  for (const module of modules) {
    for (const command of module.commands) {
      map.set(command.name.toLowerCase(), command);
      if (command.aliases) {
        for (const alias of command.aliases) {
          map.set(alias.toLowerCase(), command);
        }
      }
    }
  }
  return map;
};

export const getTextCommand = (name: string): TextCommandDefinition | undefined => {
  if (!commandCache) {
    commandCache = buildCommands();
  }
  return commandCache.get(name.toLowerCase());
};
