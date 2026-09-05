export interface DeezerArtist {
  id: number;
  name: string;
  picture?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  nb_album?: number;
  nb_fan?: number;
  link?: string;
}

export interface DeezerAlbum {
  id: number;
  title: string;
  cover?: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  link?: string;
  artist?: { id: number; name: string };
}

export interface DeezerTrack {
  id: number;
  title: string;
  duration?: number;
  link?: string;
  album?: DeezerAlbum;
  artist?: { id: number; name: string; picture_xl?: string };
}
