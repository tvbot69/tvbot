import type { LfmImage } from './recentTracksLfm';

export interface UserInfoResponseLfm {
  user: {
    name: string;
    realname?: string;
    image?: LfmImage[];
    country?: string;
    registered: { unixtime: string };
    playcount: string;
  };
}
