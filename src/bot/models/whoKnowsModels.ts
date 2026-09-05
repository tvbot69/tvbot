import type { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { Guild } from '@persistence/domain/models/guild';

export interface WhoKnowsUser {
  userId: number;
  playcount: number;
  lastFmUsername: string;
  discordName?: string;
  discordUserId?: string;
  registeredLastFm?: Date;
  privacyLevel?: PrivacyLevel;
  lastUsed?: Date;
  lastMessage?: Date;
  sameServer?: boolean;
  hasCrown?: boolean;
}

export interface FilterStats {
  startCount: number;
  endCount: number;
  activityThresholdFiltered?: number;
  blockedFiltered?: number;
  requesterFiltered?: boolean;
}

export interface WhoKnowsArtistContext {
  guild: Guild | null;
  guildUsers: Map<number, FullGuildUserDetails>;
  filteredUsersWithArtist: WhoKnowsUser[];
  filterStats: FilterStats;
  genres?: string[];
  crownModel?: import('@domain/models/crownModels').CrownModel | null;
}

export interface WhoKnowsSettings {
  newSearchValue: string;
  responseMode: WhoKnowsMode;
  qualityFilterDisabled: boolean;
  redirectsEnabled: boolean;
}
