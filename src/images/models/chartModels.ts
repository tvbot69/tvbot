import { TimePeriod } from '@domain/enums/timePeriod';

export enum ChartType {
  Album = 'album',
  Artist = 'artist',
  Track = 'track',
}

export enum ChartTheme {
  Light = 'light',
  Dark = 'dark',
  LastFm = 'lastfm',
}

export interface ChartSettings {
  rows: number;
  columns: number;
  type: ChartType;
  theme: ChartTheme;
  title?: string;
  showTitle: boolean;
  padding: number;
  imageSizePx: number;
  timePeriod: TimePeriod;
  rainbowSort?: boolean;
  fontFamily?: string;
}

export interface ChartItem {
  name: string;
  artistName?: string;
  imageUrl?: string;
  sizePx?: number;
  showTitle?: boolean;
}
