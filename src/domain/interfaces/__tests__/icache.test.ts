import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { container } from 'tsyringe';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CacheService } from '@bot/services/system/cacheService';
import { ICache, ICACHE } from '../icache';

/**
 * A minimal ICache. The point of the test below is that a *test double* can
 * satisfy the port, which is the whole reason the interface exists.
 */
class FakeCache implements ICache {
  readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
}

describe('ICache port', () => {
  it('a test double can implement it without extending anything', () => {
    // If ICache accidentally declared the whole CacheService surface, this
    // class would not compile. That is the guard on keeping the port narrow.
    const fake = new FakeCache();
    expect(typeof fake.get).toBe('function');
    expect(typeof fake.set).toBe('function');
  });

  it('is resolvable from the container under the ICACHE token', () => {
    // @inject(ICACHE) in lastFmRepository is a RUNTIME concern. If the token
    // were never bound in the composition root, every Last.fm top-list read
    // would throw at resolve time and no unit test would notice - the
    // repository is only ever container-resolved, never constructed directly.
    const fake = new FakeCache();
    container.registerInstance<ICache>(ICACHE, fake);
    expect(container.resolve<ICache>(ICACHE)).toBe(fake);
  });

  it('uses a string token, so src/ never imports the implementation', () => {
    expect(typeof ICACHE).toBe('string');
  });

  it('IS bound in the composition root', () => {
    // The test above registers the token itself, so it proves the mechanism
    // works - not that startup.ts actually binds it. LastFmRepository is only
    // ever container-resolved, so a missing binding throws at runtime on the
    // first Last.fm top-list read and nothing else catches it.
    const startup = readFileSync(join(process.cwd(), 'src', 'bot', 'startup.ts'), 'utf8');
    expect(startup).toContain(`registerInstance<ICache>(ICACHE,`);
  });

  it('CacheService satisfies the port structurally', () => {
    // Compile-time guarantee, asserted at runtime so a signature drift on
    // CacheService breaks a test rather than a deployment.
    const svc = new CacheService(10);
    const asPort: ICache = svc;
    expect(typeof asPort.get).toBe('function');
  });
});
