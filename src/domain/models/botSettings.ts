export interface DiscordConfig {
  token: string;
  botUserId: string;
  applicationId: string;
}

export interface DatabaseConfig {
  connectionString: string;
}

export interface LoggingConfig {
  seqServerUrl?: string;
  seqApiKey?: string;
}

export interface BotConfig {
  prefix: string;
  baseServerId?: string;
  stagingChannelId?: string;
  useShardEnvConfig: boolean;
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

export interface SpotifyConfig {
  key: string;
  secret: string;
}

export interface AppleMusicConfig {
  secret: string;
  keyId: string;
  teamId: string;
}

export interface GeniusConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
}

export interface AuddConfig {
  apiToken: string;
}

export interface GoogleConfig {
  youtubeApiKey: string;
}

export interface DiscogsConfig {
  key: string;
  secret: string;
}

export interface RedisConfig {
  url: string;
}

export interface BotSettings {
  environment: string;
  discord: DiscordConfig;
  database: DatabaseConfig;
  logging?: LoggingConfig;
  bot: BotConfig;
  shards?: ShardConfig;
  lastFm: LastFmConfig;
  spotify: SpotifyConfig;
  appleMusic?: AppleMusicConfig;
  genius: GeniusConfig;
  audd: AuddConfig;
  google: GoogleConfig;
  discogs: DiscogsConfig;
  redis: RedisConfig;
}
