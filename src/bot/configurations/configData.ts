import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { BotSettings } from '@domain/models/botSettings';
import { Logger } from '@domain/logger';
import { assertValidEnvironment } from './envValidator';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || value.startsWith('CHANGE-ME')) {
    Logger.error(`Missing required configuration value ${name}.`);
    throw new Error(`Missing required configuration value: ${name}`);
  }
  return value;
};

const optional = (name: string): string | undefined => {
  const value = process.env[name];
  return value && !value.startsWith('CHANGE-ME') ? value : undefined;
};

const buildSettings = (): BotSettings => {
  const envPath = path.resolve(process.cwd(), '.env');
  const hasEnvFile = fs.existsSync(envPath);
  const hasEnvVars = !!(process.env.DISCORD_TOKEN && process.env.DATABASE_URL);

  if (!hasEnvFile && !hasEnvVars) {
    Logger.error(`No .env file found at ${envPath} and environment variables are not set. Copy .env.example to .env and fill in your keys.`);
    throw new Error('Missing .env file and environment variables');
  }

  // Validate environment integrity
  assertValidEnvironment();

  return {
    environment: optional('ENVIRONMENT') ?? 'local',
    discord: {
      token: required('DISCORD_TOKEN'),
      botUserId: optional('DISCORD_BOT_USER_ID') ?? '0',
      applicationId: optional('DISCORD_APPLICATION_ID') ?? '0',
    },
    database: {
      connectionString: required('DATABASE_URL'),
    },
    logging: {
      seqServerUrl: optional('SEQ_SERVER_URL'),
      seqApiKey: optional('SEQ_API_KEY'),
    },
    bot: {
      prefix: optional('BOT_PREFIX') ?? '.',
      baseServerId: optional('BASE_SERVER_ID'),
      stagingChannelId: optional('STAGING_CHANNEL_ID'),
      useShardEnvConfig: false,
    },
    lastFm: {
      publicKey: required('LASTFM_API_KEY'),
      privateKey: required('LASTFM_API_SECRET'),
      userUpdateFrequencyInHours: Number(optional('LASTFM_USER_UPDATE_FREQUENCY_HOURS') ?? 24),
      userIndexFrequencyInDays: Number(optional('LASTFM_USER_INDEX_FREQUENCY_DAYS') ?? 120),
    },
    spotify: {
      key: optional('SPOTIFY_CLIENT_ID') ?? '',
      secret: optional('SPOTIFY_CLIENT_SECRET') ?? '',
    },
    genius: {
      clientId: optional('GENIUS_CLIENT_ID') ?? '',
      clientSecret: optional('GENIUS_CLIENT_SECRET') ?? '',
      accessToken: optional('GENIUS_CLIENT_ACCESS_TOKEN') ?? '',
    },
    audd: {
      apiToken: optional('AUDD_API_TOKEN') ?? '',
    },
    google: {
      youtubeApiKey: optional('YOUTUBE_API_KEY') ?? '',
    },
    discogs: {
      key: optional('DISCOGS_KEY') ?? '',
      secret: optional('DISCOGS_SECRET') ?? '',
    },
    redis: {
      url: optional('REDIS_URL') ?? 'redis://localhost:6379',
    },
  };
};

let settings: BotSettings | null = null;

export const ConfigData = {
  get Data(): BotSettings {
    if (!settings) {
      settings = buildSettings();
    }
    return settings;
  },
};
