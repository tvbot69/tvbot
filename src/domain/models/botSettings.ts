export interface DiscordConfig {
  token: string;
  applicationId: string;
}

export interface DatabaseConfig {
  connectionString: string;
}

export interface BotConfig {
  prefix: string;
  stagingChannelId?: string;
}

export interface ShardConfig {
  mainInstance: boolean;
  startShard?: number;
  endShard?: number;
  totalShards?: number;
  instanceName?: string;
}

export interface LastFmConfig {
  publicKey: string;
  privateKey: string;
  userUpdateFrequencyInHours: number;
  userIndexFrequencyInDays: number;
}

export interface SpotifyCredential {
  key: string;
  secret: string;
}

export interface SpotifyConfig {
  key: string;
  secret: string;
  credentials?: SpotifyCredential[];
}

export interface AppleMusicConfig {
  secret: string;
  keyId: string;
  teamId: string;
}

export interface GoogleConfig {
  youtubeApiKey: string;
}

export interface RedisConfig {
  url: string;
}

export interface BotSettings {
  environment: string;
  discord: DiscordConfig;
  database: DatabaseConfig;
  bot: BotConfig;
  shards?: ShardConfig;
  lastFm: LastFmConfig;
  spotify: SpotifyConfig;
  appleMusic?: AppleMusicConfig;
  google: GoogleConfig;
  redis: RedisConfig;
}
