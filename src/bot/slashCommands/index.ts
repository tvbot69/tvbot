import { container } from 'tsyringe';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import type { SlashCommandDefinition } from '@bot/models/commandModels';
import { UserSlashCommands } from '@bot/slashCommands/userSlashCommands';
import { StaticSlashCommands } from '@bot/slashCommands/staticSlashCommands';
import { ChartSlashCommands } from '@bot/slashCommands/chartSlashCommands';
import { LoginSlashCommands } from '@bot/slashCommands/loginSlashCommands';
import { SettingsSlashCommands } from '@bot/slashCommands/settingsSlashCommands';
import { AlbumSlashCommands } from '@bot/slashCommands/albumSlashCommands';
import { WhoKnowsSlashCommands } from '@bot/slashCommands/whoKnowsSlashCommands';
import { FriendSlashCommands } from '@bot/slashCommands/friendSlashCommands';
import { MusicSlashCommands } from '@bot/slashCommands/musicSlashCommands';
import { TrackSlashCommands } from '@bot/slashCommands/trackSlashCommands';
import { TopSlashCommands } from '@bot/slashCommands/topSlashCommands';
import { OverviewSlashCommands } from '@bot/slashCommands/overviewSlashCommands';
import { ArtistTrackSlashCommands } from '@bot/slashCommands/artistTrackSlashCommands';
import { UpdateSlashCommands } from '@bot/slashCommands/updateSlashCommands';
import { ArtistSlashCommands } from '@bot/slashCommands/artistSlashCommands';
import { TasteSlashCommands } from '@bot/slashCommands/tasteSlashCommands';
import { CrownSlashCommands } from '@bot/slashCommands/crownSlashCommands';
import { PlaycountSlashCommands } from '@bot/slashCommands/playcountSlashCommands';
import { ProfileSlashCommands } from '@bot/slashCommands/profileSlashCommands';
import { StreakSlashCommands } from '@bot/slashCommands/streakSlashCommands';
import { LibrarySearchSlashCommands } from '@bot/slashCommands/librarySearchSlashCommands';
import { ServerSlashCommands } from '@bot/slashCommands/serverSlashCommands';
import { GenreSlashCommands } from '@bot/slashCommands/genreSlashCommands';
import { CountrySlashCommands } from '@bot/slashCommands/countrySlashCommands';
import { GameSlashCommands } from '@bot/slashCommands/gameSlashCommands';
import { IntelligenceSlashCommands } from '@bot/slashCommands/intelligenceSlashCommands';
import { GuildAdminSlashCommands } from '@bot/slashCommands/guildAdminSlashCommands';
import { UserHubSlashCommands } from '@bot/slashCommands/userHubSlashCommands';
import { ImportSlashCommands } from '@bot/slashCommands/importSlashCommands';
import { StreamingSlashCommands } from '@bot/slashCommands/streamingSlashCommands';
import { HelpSlashCommands } from '@bot/slashCommands/helpSlashCommands';
import { ExposedSlashCommands } from '@bot/slashCommands/exposedSlashCommands';

let commandCache: Map<string, SlashCommandDefinition> | null = null;

const buildCommands = (): Map<string, SlashCommandDefinition> => {
  const modules = [
    container.resolve(HelpSlashCommands),
    container.resolve(ExposedSlashCommands),
    container.resolve(UserSlashCommands),
    container.resolve(PlaycountSlashCommands),
    container.resolve(ProfileSlashCommands),
    container.resolve(StreakSlashCommands),
    container.resolve(LibrarySearchSlashCommands),
    container.resolve(ServerSlashCommands),
    container.resolve(GenreSlashCommands),
    container.resolve(CountrySlashCommands),
    container.resolve(GameSlashCommands),
    container.resolve(IntelligenceSlashCommands),
    container.resolve(GuildAdminSlashCommands),
    container.resolve(UserHubSlashCommands),
    container.resolve(ImportSlashCommands),
    container.resolve(StreamingSlashCommands),
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
