export enum FriendType {
  Normal = 1,
  VisibleInNowPlaying = 2,
  CloseFriend = 3,
}

export const FriendTypeNames: Record<FriendType, string> = {
  [FriendType.Normal]: '👥 Normal',
  [FriendType.VisibleInNowPlaying]: '👁️ Visible everywhere',
  [FriendType.CloseFriend]: '⭐ Close friend',
};

export const FriendTypeDescriptions: Record<FriendType, string> = {
  [FriendType.Normal]: 'Shown in friend commands, but not in `friendsfm`',
  [FriendType.VisibleInNowPlaying]: 'Also shown in `friendsfm`',
  [FriendType.CloseFriend]: 'Always visible in WhoKnows no matter their rank, plus in `friendsfm`',
};
