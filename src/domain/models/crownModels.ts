export interface UserCrownDto {
  crownId: number;
  guildId: string;
  userId: number;
  artistName: string;
  currentPlaycount: number;
  startPlaycount: number;
  created: Date;
  modified: Date;
  active: boolean;
  seededCrown: boolean;
  userNameLastFm?: string;
  discordUserId?: string;
  displayName?: string;
}

export interface CrownModel {
  crown: UserCrownDto;
  previousCrown?: UserCrownDto | null;
  stolen?: boolean;
  claimed?: boolean;
  crownResult?: string | null;
}

export type CrownViewType = 'Playcount' | 'Recent' | 'Stolen';

export interface CrownLeaderboardEntry {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  displayName: string;
  crownCount: number;
}
