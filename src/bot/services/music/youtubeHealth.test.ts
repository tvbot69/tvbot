import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { YoutubeHealth, healthFor } from './youtubeHealth';

describe('YoutubeHealth', () => {
  it('recognizes outage signatures and ignores the rest', () => {
    expect(YoutubeHealth.isOutage({ message: 'This video requires login.' })).toBe(true);
    expect(YoutubeHealth.isOutage({ message: "Sign in to confirm you're not a bot" })).toBe(true);
    expect(YoutubeHealth.isOutage({ message: 'Must find sig function from script: x' })).toBe(true);
    expect(YoutubeHealth.isOutage({ message: 'All clients failed to load the item.' })).toBe(true);
    expect(YoutubeHealth.isOutage({ message: 'Track has no audio tracks' })).toBe(false);
    expect(YoutubeHealth.isOutage(undefined)).toBe(false);
    expect(YoutubeHealth.isOutage({})).toBe(false);
  });

  it('serves the full ladder while healthy', () => {
    const health = new YoutubeHealth();
    expect(health.ladder({ resolver: true }, 1000)).toEqual(['resolver', 'plugin', 'soundcloud']);
    expect(health.ladder({ resolver: false }, 1000)).toEqual(['plugin', 'soundcloud']);
  });

  it('drops the plugin rung when disabled (Home without HOME_PLUGIN_RUNG)', () => {
    const health = new YoutubeHealth();
    expect(health.ladder({ resolver: true, plugin: false }, 1000)).toEqual(['resolver', 'soundcloud']);
    expect(health.ladder({ resolver: false, plugin: false }, 1000)).toEqual(['soundcloud']);
  });

  it('declares YouTube down after 3 distinct outage songs, probes, and recovers', () => {
    const health = new YoutubeHealth({ distinctSongs: 3, windowMs: 120_000, downMs: 600_000 });
    const outage = { message: 'This video requires login.' };

    health.recordFailure('a - x', outage, 0);
    health.recordFailure('b - y', outage, 1000);
    expect(health.ladder({ resolver: true }, 2000)).toEqual(['resolver', 'plugin', 'soundcloud']);

    health.recordFailure('c - z', outage, 3000);
    // Down: SoundCloud-first (resolver rung kept when configured), no probes yet
    expect(health.ladder({ resolver: true }, 4000)).toEqual(['resolver', 'soundcloud']);
    expect(health.ladder({ resolver: false }, 4000)).toEqual(['soundcloud']);
    expect(health.ladder({ resolver: true }, 70000)).toEqual(['resolver', 'soundcloud']);

    // At expiry exactly one plugin probe goes through, then the slot closes
    expect(health.ladder({ resolver: true }, 603000)).toEqual(['resolver', 'plugin', 'soundcloud']);
    expect(health.ladder({ resolver: true }, 603100)).toEqual(['resolver', 'soundcloud']);

    // A failed probe re-arms the outage
    health.recordFailure('d - w', outage, 603200);
    expect(health.ladder({ resolver: true }, 603300)).toEqual(['resolver', 'soundcloud']);

    // A surviving track clears everything immediately
    health.recordSuccess();
    expect(health.ladder({ resolver: true }, 603400)).toEqual(['resolver', 'plugin', 'soundcloud']);
  });

  it('ignores repeated failures of the same song for the trip count', () => {
    const health = new YoutubeHealth({ distinctSongs: 3, windowMs: 120_000, downMs: 600_000 });
    const outage = { message: 'All clients failed to load the item.' };
    health.recordFailure('a - x', outage, 0);
    health.recordFailure('a - x', outage, 1000);
    health.recordFailure('a - x', outage, 2000);
    expect(health.ladder({ resolver: true }, 3000)[0]).toBe('resolver');
  });

  it('never trips on distinct non-outage errors (private/unavailable)', () => {
    const health = new YoutubeHealth({ distinctSongs: 3, windowMs: 120_000, downMs: 600_000 });
    health.recordFailure('a - x', { message: 'This video is private.' }, 0);
    health.recordFailure('b - y', { message: 'This video is unavailable.' }, 1000);
    health.recordFailure('c - z', { message: 'Track has no audio tracks' }, 2000);
    expect(health.ladder({ resolver: true }, 3000)[0]).toBe('resolver');
    expect(health.isDown(3000)).toBe(false);
  });

  it('tracks health independently per node', () => {
    const outage = { message: 'This video requires login.' };
    const home = healthFor('test-home-health');
    home.recordFailure('a - x', outage, 0);
    home.recordFailure('b - y', outage, 1);
    home.recordFailure('c - z', outage, 2);
    expect(healthFor('test-home-health').ladder({ resolver: false }, 3)).toEqual(['soundcloud']);
    expect(healthFor('test-other-health').ladder({ resolver: false }, 3)).toEqual(['plugin', 'soundcloud']);
  });
});
