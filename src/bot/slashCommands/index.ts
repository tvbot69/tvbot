import { container } from 'tsyringe';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import type { SlashCommandDefinition } from '@bot/models/commandModels';
import { Logger } from '@domain/logging/logger';
import { UserSlashCommands } from '@bot/slashCommands/user/userSlashCommands';
import { StaticSlashCommands } from '@bot/slashCommands/meta/staticSlashCommands';
import { ChartSlashCommands } from '@bot/slashCommands/charts/chartSlashCommands';
import { LoginSlashCommands } from '@bot/slashCommands/user/loginSlashCommands';
import { SettingsSlashCommands } from '@bot/slashCommands/user/settingsSlashCommands';
import { AlbumSlashCommands } from '@bot/slashCommands/library/albumSlashCommands';
import { WhoKnowsSlashCommands } from '@bot/slashCommands/whoknows/whoKnowsSlashCommands';
import { FriendSlashCommands } from '@bot/slashCommands/social/friendSlashCommands';
import { MusicSlashCommands } from '@bot/slashCommands/music/musicSlashCommands';
import { TrackSlashCommands } from '@bot/slashCommands/library/trackSlashCommands';
import { TopSlashCommands } from '@bot/slashCommands/library/topSlashCommands';
import { OverviewSlashCommands } from '@bot/slashCommands/library/overviewSlashCommands';
import { ArtistTrackSlashCommands } from '@bot/slashCommands/library/artistTrackSlashCommands';
import { UpdateSlashCommands } from '@bot/slashCommands/music/updateSlashCommands';
import { ArtistSlashCommands } from '@bot/slashCommands/library/artistSlashCommands';
import { TasteSlashCommands } from '@bot/slashCommands/social/tasteSlashCommands';
import { CrownSlashCommands } from '@bot/slashCommands/crown/crownSlashCommands';
import { PlaycountSlashCommands } from '@bot/slashCommands/library/playcountSlashCommands';
import { ProfileSlashCommands } from '@bot/slashCommands/user/profileSlashCommands';
import { StreakSlashCommands } from '@bot/slashCommands/user/streakSlashCommands';
import { LibrarySearchSlashCommands } from '@bot/slashCommands/library/librarySearchSlashCommands';
import { ServerSlashCommands } from '@bot/slashCommands/guild/serverSlashCommands';
import { GenreSlashCommands } from '@bot/slashCommands/library/genreSlashCommands';
import { CountrySlashCommands } from '@bot/slashCommands/library/countrySlashCommands';
import { GameSlashCommands } from '@bot/slashCommands/guild/gameSlashCommands';
import { IntelligenceSlashCommands } from '@bot/slashCommands/intelligence/intelligenceSlashCommands';
import { GuildAdminSlashCommands } from '@bot/slashCommands/guild/guildAdminSlashCommands';
import { UserHubSlashCommands } from '@bot/slashCommands/user/userHubSlashCommands';
import { ImportSlashCommands } from '@bot/slashCommands/imports/importSlashCommands';
import { StreamingSlashCommands } from '@bot/slashCommands/music/streamingSlashCommands';
import { RateMySlashCommands } from '@bot/slashCommands/music/rateMySlashCommands';
import { HelpSlashCommands } from '@bot/slashCommands/meta/helpSlashCommands';
import { ExposedSlashCommands } from '@bot/slashCommands/social/exposedSlashCommands';

let commandCache: Map<string, SlashCommandDefinition> | null = null;
let duplicateNamesCache: string[] | null = null;

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
    container.resolve(RateMySlashCommands),
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
  const duplicates: string[] = [];
  const claim = (name: string, command: SlashCommandDefinition): void => {
    const k = name.toLowerCase();
    const previous = map.get(k);
    if (previous && previous !== command) {
      duplicates.push(k);
      Logger.warn(
        { command: k, kept: command.data.name, dropped: previous.data.name },
        'Slash command name collision — the later registration wins',
      );
    }
    map.set(k, command);
  };
  for (const module of modules) {
    for (const command of module.commands) {
      claim(command.data.name, command);
    }
  }
  duplicateNamesCache = duplicates;
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

/**
 * Top-level slash names that collided during the last build. Later wins at
 * runtime, same as the text registry. Empty when collision-free. Exists so
 * deploy and tests see overwrites `getSlashCommandPayloads()` hides.
 */
export const getSlashCommandDuplicates = (): string[] => {
  if (!commandCache) {
    commandCache = buildCommands();
  }
  return [...(duplicateNamesCache ?? [])];
};
