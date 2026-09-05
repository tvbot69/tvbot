export enum UpdateType {
  RecentPlays = 1 << 1,
  AllPlays = 1 << 2,
  Full = 1 << 3,
  Artists = 1 << 4,
  Albums = 1 << 5,
  Tracks = 1 << 6,
  Automatic = 1 << 7,
  Command = 1 << 8,
}

export function parseUpdateType(options?: string): { updateType: UpdateType; optionPicked: boolean } {
  if (!options || !options.trim()) {
    return { updateType: UpdateType.RecentPlays, optionPicked: false };
  }
  const clean = options.trim().toLowerCase();
  if (['full', 'force', 'f', 'all'].includes(clean)) {
    return { updateType: UpdateType.Full, optionPicked: true };
  }
  if (['plays', 'allplays', 'p'].includes(clean)) {
    return { updateType: UpdateType.AllPlays, optionPicked: true };
  }
  if (['artists', 'artist', 'a'].includes(clean)) {
    return { updateType: UpdateType.Artists, optionPicked: true };
  }
  if (['albums', 'album', 'ab'].includes(clean)) {
    return { updateType: UpdateType.Albums, optionPicked: true };
  }
  if (['tracks', 'track', 'tr', 't'].includes(clean)) {
    return { updateType: UpdateType.Tracks, optionPicked: true };
  }
  return { updateType: UpdateType.RecentPlays, optionPicked: false };
}
