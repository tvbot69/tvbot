export enum UserSetting {
  FmMode = 3,
  WkMode = 4,
  CoverType = 5,
  OutOfSync = 6,
  SpotifyImport = 10,
  CommandShortcuts = 11,
  UserReactions = 12,
  Localization = 15,
  BotScrobbling = 20,
  DeleteAccount = 30,
}

export interface UserSettingOptionMeta {
  name: string;
  description: string;
  value: string;
}

export const UserSettingMeta: Record<UserSetting, UserSettingOptionMeta> = {
  [UserSetting.FmMode]: {
    name: 'Change your .fm',
    description: 'Customize your .fm command appearance',
    value: 'FmMode',
  },
  [UserSetting.WkMode]: {
    name: 'WhoKnows mode',
    description: 'Set your default WhoKnows and top list modes',
    value: 'WkMode',
  },
  [UserSetting.CoverType]: {
    name: 'Album cover type',
    description: 'Set your preferred album cover type (animated or still)',
    value: 'CoverType',
  },
  [UserSetting.OutOfSync]: {
    name: 'Out of sync',
    description: 'Info on what to do when Spotify and Last.fm are out of sync',
    value: 'OutOfSync',
  },
  [UserSetting.SpotifyImport]: {
    name: 'Spotify & Apple Music imports',
    description: 'Add and manage your Spotify & Apple Music imports',
    value: 'SpotifyImport',
  },
  [UserSetting.CommandShortcuts]: {
    name: 'Command shortcuts',
    description: 'Configure your text command shortcuts',
    value: 'CommandShortcuts',
  },
  [UserSetting.UserReactions]: {
    name: 'User reactions',
    description: 'Set personal automated emoji reactions',
    value: 'UserReactions',
  },
  [UserSetting.Localization]: {
    name: 'Localization',
    description: 'Set your timezone and number formatting',
    value: 'Localization',
  },
  [UserSetting.BotScrobbling]: {
    name: 'Music bot scrobbling',
    description: 'Toggle automatically scrobbling other music bots',
    value: 'BotScrobbling',
  },
  [UserSetting.DeleteAccount]: {
    name: 'Delete account',
    description: 'Delete your tvbot data and account',
    value: 'DeleteAccount',
  },
};
