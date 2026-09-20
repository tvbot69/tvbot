import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { LoginService, LoginStatus } from './loginService';

const makeService = (linkedCount: number, alreadyLinkedName: string | null = null) => {
  const setUserLastFm = vi.fn(async () => ({ userId: 9 }));
  const service = new LoginService(
    { getAuthSession: vi.fn(async () => ({ name: 'SomeUser', key: 'sk' })) } as never,
    {
      setUserLastFm,
      getUserByDiscordId: vi.fn(async () =>
        alreadyLinkedName ? { userId: 9, userNameLastFm: alreadyLinkedName } : null,
      ),
    } as never,
    {
      get: vi.fn(async () => 'pending-token'),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as never,
    { indexUser: vi.fn(async () => undefined) } as never,
    {
      setSessionKey: vi.fn(async () => undefined),
      countUsersByLastFmName: vi.fn(async () => linkedCount),
    } as never,
  );
  return { service, setUserLastFm };
};

describe('LoginService alt cap (Phase 4)', () => {
  it('links normally under the cap', async () => {
    const { service, setUserLastFm } = makeService(2);
    const res = await service.confirmLogin('discord-1');
    expect(res.status).toBe(LoginStatus.Success);
    expect(setUserLastFm).toHaveBeenCalled();
  });

  it('refuses a sixth Discord row on the same Last.fm account', async () => {
    const { service, setUserLastFm } = makeService(5);
    const res = await service.confirmLogin('discord-6');
    expect(res.status).toBe(LoginStatus.AltLimitExceeded);
    expect(setUserLastFm).not.toHaveBeenCalled();
  });

  it('allows re-linking the same account (re-auth is not an alt)', async () => {
    const { service, setUserLastFm } = makeService(5, 'SomeUser');
    const res = await service.confirmLogin('discord-1');
    expect(res.status).toBe(LoginStatus.Success);
    expect(setUserLastFm).toHaveBeenCalled();
  });
});
