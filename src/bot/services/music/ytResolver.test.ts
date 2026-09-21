import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveViaHome, resolverEnabled } from './ytResolver';

const SAVED_URL = process.env.HOME_RESOLVER_URL;
const SAVED_TOKEN = process.env.HOME_RESOLVER_TOKEN;

const setEnv = (url?: string, token?: string) => {
  if (url === undefined) delete process.env.HOME_RESOLVER_URL;
  else process.env.HOME_RESOLVER_URL = url;
  if (token === undefined) delete process.env.HOME_RESOLVER_TOKEN;
  else process.env.HOME_RESOLVER_TOKEN = token;
};

describe('ytResolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setEnv('http://127.0.0.1:2335', 'tok');
  });

  it('stays disabled without configuration and never fetches', async () => {
    setEnv(undefined, undefined);
    expect(resolverEnabled()).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(resolveViaHome('abc123def45')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('returns the path on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'C:\\ytres\\cache\\abc123def45.webm' }),
    } as Response);
    await expect(resolveViaHome('abc123def45')).resolves.toBe('C:\\ytres\\cache\\abc123def45.webm');
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('treats 502 as a per-video miss without pausing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502 } as Response);
    await expect(resolveViaHome('abc123def45')).resolves.toBeNull();
    await expect(resolveViaHome('abc123def45')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(resolverEnabled()).toBe(true);
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('pauses for 2 minutes when the resolver is unreachable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(resolveViaHome('abc123def45')).resolves.toBeNull();
    expect(resolverEnabled()).toBe(false);
    await expect(resolveViaHome('abc123def45')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    setEnv(SAVED_URL, SAVED_TOKEN);
  });
});
