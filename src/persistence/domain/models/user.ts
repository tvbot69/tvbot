import { PrivacyLevel } from '@domain/enums/privacyLevel';

export enum UserType {
  User = 'User',
  Contributor = 'Contributor',
  Admin = 'Admin',
  Owner = 'Owner',
}

export enum DataSource {
  LastFm = 'LastFm',
  SpotifyImport = 'SpotifyImport',
  AppleMusicImport = 'AppleMusicImport',
}

export interface User {
  userId: number;
  userNameLastFm: string;
  discordUserId: string;
  registeredOn: Date;
  registeredLastFm?: Date;
  sessionKey?: string;
  userType: UserType;
  dataSource: DataSource;
  timeZone?: string;
  numberFormat?: string;
  privacyLevel: PrivacyLevel;
  lastUpdate?: Date;
  lastIndexed?: Date;
  totalPlayCount?: number;
  lastScrobbleUpdate?: Date;
  lastUsed?: Date;
}

import { FriendType } from '@domain/enums/friendType';

export interface Friend {
  friendId: number;
  userId: number;
  lastFmUserName: string;
  friendUserId?: number;
  lastFmFriend: boolean;
  friendType: FriendType;
  created?: Date;
  modified?: Date;
  friendUser?: User;
}

