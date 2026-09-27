import { container } from 'tsyringe';
import { Logger } from '@domain/logger';
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
import { GenreCommands } from './lastfm/genreCommands';
import { CountryCommands } from './lastfm/countryCommands';
import { GameCommands } from './lastfm/gameCommands';
import { IntelligenceCommands } from './lastfm/intelligenceCommands';
import { GuildAdminCommands } from './guild/guildAdminCommands';
import { UserHubCommands } from './user/userHubCommands';
import { ImportCommands } from './thirdParty/importCommands';
import { StreamingCommands } from './thirdParty/streamingCommands';
import { AutopostCommands } from './guild/autopostCommands';
import { HelpCommands } from './helpCommands';
import { ExposedCommands } from './lastfm/exposedCommands';

let commandCache: Map<string, TextCommandDefinition> | null = null;

const buildCommands = (): Map<string, TextCommandDefinition> => {
  const modules = [
    container.resolve(HelpCommands),
    container.resolve(ExposedCommands),
    container.resolve(PlayCommands),
    container.resolve(PlaycountCommands),
    container.resolve(ProfileCommands),
    container.resolve(StreakCommands),
    container.resolve(LibrarySearchCommands),
    container.resolve(ServerCommands),
    container.resolve(GenreCommands),
    container.resolve(CountryCommands),
    container.resolve(GameCommands),
    container.resolve(IntelligenceCommands),
    container.resolve(GuildAdminCommands),
    container.resolve(UserHubCommands),
    container.resolve(ImportCommands),
    container.resolve(StreamingCommands),
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
    container.resolve(AutopostCommands),
    container.resolve(FootballCommands),
  ];
  const map = new Map<string, TextCommandDefinition>();
  const owner = new Map<string, string>();
  // Registration is last-write-wins, so a collision is SILENT: MusicCommands
  // is resolved late and was quietly stealing `.np`, `.rm` and `.history`
  // from the Last.fm commands, so those did something entirely different from
  // what a Last.fm user expected. A command's own name always wins over
  // another command's ALIAS (an explicit name is a stronger signal), and every
  // remaining collision is logged rather than hidden.
  const claim = (key: string, command: TextCommandDefinition, isAlias: boolean): void => {
    const k = key.toLowerCase();
    const previous = map.get(k);
    if (previous && previous !== command) {
      const previousName = previous.name.toLowerCase();
      const loser = isAlias && previousName !== k ? k : previousName;
      Logger.warn(
        { command: k, kept: map.get(k)?.name, dropped: loser },
        'Text command name collision — the later registration wins',
      );
    }
    map.set(k, command);
    owner.set(k, command.name);
  };

  // Pass 1: canonical names (strongest).
  for (const module of modules) {
    for (const command of module.commands) {
      claim(command.name, command, false);
    }
  }
  // Pass 2: aliases only fill names nobody claimed.
  for (const module of modules) {
    for (const command of module.commands) {
      for (const alias of command.aliases ?? []) {
        const k = alias.toLowerCase();
        if (map.has(k)) continue;
        claim(alias, command, true);
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

/**
 * The whole resolved registry, keyed by lowercased name.
 *
 * Exists for the same reason `getSlashCommandPayloads()` exists on the slash
 * side: the registry is built by a private two-pass function whose collision
 * behaviour is the thing most worth testing, and a single-name lookup cannot
 * express "no two of these collide". Without this, the collision invariants can
 * only be checked by re-parsing command definitions out of source, which tests
 * the source rather than the objects the bot actually ships.
 *
 * Returns the live map, so callers must not mutate it.
 */
export const getTextCommands = (): ReadonlyMap<string, TextCommandDefinition> => {
  if (!commandCache) {
    commandCache = buildCommands();
  }
  return commandCache;
};
