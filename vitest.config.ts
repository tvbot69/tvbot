import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@bot': new URL('./src/bot', import.meta.url).pathname,
      '@domain': new URL('./src/domain', import.meta.url).pathname,
      '@lastfm': new URL('./src/lastfm', import.meta.url).pathname,
      '@persistence': new URL('./src/persistence', import.meta.url).pathname,
      '@images': new URL('./src/images', import.meta.url).pathname,
      '@applemusic': new URL('./src/applemusic', import.meta.url).pathname,
      '@spotify': new URL('./src/spotify', import.meta.url).pathname,
      '@deezer': new URL('./src/deezer', import.meta.url).pathname,
      '@discogs': new URL('./src/discogs', import.meta.url).pathname,
    },
  },
});
