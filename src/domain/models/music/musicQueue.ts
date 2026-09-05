import type { MusicTrack } from './musicTrack';

export type LoopMode = 'off' | 'track' | 'queue';

export type FilterName =
  | 'bassboost'
  | 'nightcore'
  | 'vaporwave'
  | 'karaoke'
  | 'tremolo'
  | 'vibrato'
  | 'rotation'
  | 'distortion'
  | 'lowpass';

export const ALL_FILTERS: FilterName[] = [
  'bassboost',
  'nightcore',
  'vaporwave',
  'karaoke',
  'tremolo',
  'vibrato',
  'rotation',
  'distortion',
  'lowpass',
];

export interface MusicQueueInfo {
  guildId: string;
  current: MusicTrack | null;
  tracks: MusicTrack[];
  totalTracks: number;
  totalDuration: number;
  remainingDuration: number;
  loopMode: LoopMode;
  volume: number;
  isPaused: boolean;
  isPlaying: boolean;
  is247: boolean;
  autoplay: boolean;
  activeFilters: string[];
  voiceChannelId?: string;
  textChannelId?: string;
  position: number; // in milliseconds
  ping: number;
}
