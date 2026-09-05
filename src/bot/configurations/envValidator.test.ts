import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnvironment } from './envValidator';

describe('validateEnvironment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('fails if DISCORD_TOKEN is missing', () => {
    delete process.env.DISCORD_TOKEN;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.LASTFM_API_KEY = 'test_key';
    process.env.LASTFM_API_SECRET = 'test_secret';

    const result = validateEnvironment();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('DISCORD_TOKEN'))).toBe(true);
  });

  it('fails if DATABASE_URL is not postgresql://', () => {
    process.env.DISCORD_TOKEN = 'a_very_long_valid_discord_bot_token_1234567890';
    process.env.DATABASE_URL = 'mysql://user:pass@localhost:3306/db';
    process.env.LASTFM_API_KEY = 'test_key';
    process.env.LASTFM_API_SECRET = 'test_secret';

    const result = validateEnvironment();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('passes when all required variables are set correctly', () => {
    process.env.DISCORD_TOKEN = 'a_very_long_valid_discord_bot_token_1234567890';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.LASTFM_API_KEY = 'valid_lastfm_key';
    process.env.LASTFM_API_SECRET = 'valid_lastfm_secret';

    const result = validateEnvironment();
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});
