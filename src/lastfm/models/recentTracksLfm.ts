export interface LfmImage {
  '#text': string;
  size: string;
}

export interface RecentTrackLfm {
  artist: { '#text': string; mbid?: string } | string;
  name: string;
  mbid?: string;
  album?: { '#text': string } | string;
  image?: LfmImage[];
  date?: { uts: string; '#text': string };
  '@attr'?: { nowplaying?: string };
}

export interface RecentTracksResponseLfm {
  recenttracks: {
    '@attr': {
      user: string;
      total: string;
      page: string;
      perPage: string;
      totalPages: string;
    };
    track: RecentTrackLfm[];
  };
}
