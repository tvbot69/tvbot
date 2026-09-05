import { Logger } from '@domain/logger';

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEnvironment(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required Core Settings
  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken || discordToken.startsWith('CHANGE-ME')) {
    errors.push('DISCORD_TOKEN is missing or has a placeholder value.');
  } else if (discordToken.length < 30) {
    errors.push('DISCORD_TOKEN appears too short to be a valid Discord bot token.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.startsWith('CHANGE-ME')) {
    errors.push('DATABASE_URL is missing or has a placeholder value.');
  } else if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) {
    errors.push('DATABASE_URL must start with "postgresql://" or "postgres://".');
  }

  const lastfmKey = process.env.LASTFM_API_KEY;
  if (!lastfmKey || lastfmKey.startsWith('CHANGE-ME')) {
    errors.push('LASTFM_API_KEY is missing or has a placeholder value.');
  }

  const lastfmSecret = process.env.LASTFM_API_SECRET;
  if (!lastfmSecret || lastfmSecret.startsWith('CHANGE-ME')) {
    errors.push('LASTFM_API_SECRET is missing or has a placeholder value.');
  }

  // Optional External Integrations (Log warnings if missing)
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    warnings.push('Spotify credentials missing (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET) — album artwork enrichment and Spotify playback will be disabled.');
  }

  if (!process.env.REDIS_URL) {
    warnings.push('REDIS_URL not specified — defaulting to in-memory LRU cache.');
  }

  if (!process.env.LAVALINK_HOST) {
    warnings.push('LAVALINK_HOST not specified — music playback commands will not be functional.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function assertValidEnvironment(): void {
  const result = validateEnvironment();

  for (const warn of result.warnings) {
    Logger.warn(`[Config Warning] ${warn}`);
  }

  if (!result.valid) {
    Logger.fatal('================ ENVIRONMENT VALIDATION FAILED ================');
    for (const err of result.errors) {
      Logger.fatal(`[Config Error] ${err}`);
    }
    Logger.fatal('================================================================');
    throw new Error(`Environment validation failed with ${result.errors.length} error(s).`);
  }
}
