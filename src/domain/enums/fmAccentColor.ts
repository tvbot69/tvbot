export enum FmAccentColor {
  LastFmRed = 1,
  CoverColor = 2,
  GuildColor = 3,
  Custom = 4,
}

export const FmAccentColorNames: Record<FmAccentColor, string> = {
  [FmAccentColor.LastFmRed]: 'Last.fm Red',
  [FmAccentColor.CoverColor]: 'Cover Color',
  [FmAccentColor.GuildColor]: 'Role Color',
  [FmAccentColor.Custom]: 'Custom',
};
