export interface RymTrack {
  position: string;
  title: string;
  duration: string;
}

export interface RymReleaseStub {
  rymId: string;
  title: string;
  artist: string;
  url: string;
  artistId: string;
  releaseType: string;
  year: number | null;
  date: string;
  rating: number | null;
  nRatings: number | null;
  nReviews: number | null;
  primaryGenres: string[];
  secondaryGenres: string[];
  descriptors: string[];
  coverUrl: string;
  position: number | null;
}

export interface RymRelease extends RymReleaseStub {
  tracklist: RymTrack[];
}

export interface RymArtistSong {
  title: string;
  url: string;
  coverUrl: string;
  releaseType: string;
}

export interface RymSong {
  slug: string;
  title: string;
  artist: string;
  url: string;
  released: string;
  year: number | null;
  rating: number | null;
  nRatings: number | null;
  appearsOn: RymArtistSong[];
}

export interface RymArtist {
  rymId: string;
  name: string;
  url: string;
  formed: string;
  located: string;
  members: string[];
  aliases: string[];
  genres: string[];
  related: string[];
  notes: string;
  discography: RymReleaseStub[];
}
