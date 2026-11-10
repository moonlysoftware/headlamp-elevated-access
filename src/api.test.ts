/*
 * Copyright 2026 The headlamp-elevated-access authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiError,
  createClient,
  createStore,
  CSRF_HEADER,
  dropElevation,
  findCluster,
  formatRemaining,
  normaliseBase,
  signInUrl,
} from './api';

function fakeFetch(responses: Array<{ status: number; body?: unknown; type?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      type: r.type ?? 'basic',
      json: () =>
        r.body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(r.body),
    } as unknown as Response);
  };
  return Object.assign(impl, { calls });
}

describe('createClient', () => {
  it('sends mutating calls with the CSRF header, JSON body and same-origin credentials', async () => {
    const f = fakeFetch([{ status: 201, body: { id: 'abc' } }]);
    const view = await createClient(f).create('staging', 'Restart the api pods');
    expect(view.id).toBe('abc');
    const { url, init } = f.calls[0];
    expect(url).toBe('/elevated-access/api/requests');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({
      cluster: 'staging',
      reason: 'Restart the api pods',
    });
  });

  it('sends GET without body and URL-encodes ids', async () => {
    const f = fakeFetch([{ status: 200, body: { approved: false } }]);
    await createClient(f, '/custom/').status('a/b');
    expect(f.calls[0].url).toBe('/custom/api/requests/a%2Fb');
    expect(f.calls[0].init.body).toBeUndefined();
    expect((f.calls[0].init.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined();
  });

  it('maps a missing auth session to a 401 ApiError', async () => {
    for (const r of [
      { status: 0, type: 'opaqueredirect' },
      { status: 401, body: {} },
    ]) {
      await expect(createClient(fakeFetch([r])).config()).rejects.toMatchObject({ status: 401 });
    }
  });

  it('surfaces the broker error message', async () => {
    const f = fakeFetch([
      { status: 409, body: { error: 'This request has not been approved yet' } },
    ]);
    await expect(createClient(f).install('x')).rejects.toThrow(/not been approved/);
    await expect(createClient(fakeFetch([{ status: 500 }])).install('x')).rejects.toBeInstanceOf(
      ApiError
    );
  });
});

describe('normaliseBase', () => {
  it('keeps same-origin paths and rejects anything else', () => {
    expect(normaliseBase(undefined)).toBe('/elevated-access');
    expect(normaliseBase(' /access/ ')).toBe('/access');
    expect(normaliseBase('https://evil.example')).toBe('/elevated-access');
    expect(normaliseBase('/a?b')).toBe('/elevated-access');
    expect(normaliseBase('relative')).toBe('/elevated-access');
    expect(normaliseBase('/a/../clusters')).toBe('/elevated-access');
  });

  it('rejects protocol-relative paths', async () => {
    expect(normaliseBase('//evil.example')).toBe('/elevated-access');
    expect(normaliseBase('/\\evil.example')).toBe('/elevated-access');
    const f = fakeFetch([{ status: 200, body: { clusters: [] } }]);
    await createClient(f, '//evil.example').config();
    expect(f.calls[0].url).toBe('/elevated-access/api/config');
  });

  it('builds the sign-in URL on the broker path', () => {
    expect(signInUrl('/elevated-access')).toBe(
      '/elevated-access/oauth2/start?rd=%2Felevated-access%2Fsigned-in'
    );
  });
});

describe('dropElevation', () => {
  it('clears the cookie through Headlamp set-token with an empty token', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await dropElevation(f, 'staging');
    expect(f.calls[0].url).toBe('/clusters/staging/set-token');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ token: '' });
  });

  it('throws when Headlamp refuses', async () => {
    await expect(dropElevation(fakeFetch([{ status: 500 }]), 'staging')).rejects.toBeInstanceOf(
      ApiError
    );
  });
});

describe('helpers', () => {
  it('findCluster matches source and target clusters only', () => {
    const cfg = {
      clusters: [
        {
          id: 'staging',
          label: 'Staging',
          sourceClusters: ['staging'],
          targetCluster: 'staging-elevated',
          ttl: '30m',
        },
      ],
    };
    expect(findCluster(cfg, 'staging')?.id).toBe('staging');
    expect(findCluster(cfg, 'staging-elevated')?.id).toBe('staging');
    expect(findCluster(cfg, 'production')).toBeNull();
    expect(findCluster(null, 'staging')).toBeNull();
  });

  it('formatRemaining', () => {
    expect(formatRemaining(100, 100_000)).toBe('expired');
    expect(formatRemaining(1000, 1_000_000 - 65_000)).toBe('1m 05s');
  });

  it('store round-trips and tolerates broken storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    const s = createStore(broken);
    expect(s.read('active', 'x')).toBeNull();
    s.write('active', 'x', { expiresAt: 1 });

    const mem = new Map<string, string>();
    const ok = createStore({
      getItem: k => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: k => void mem.delete(k),
    });
    ok.write('pending', 'c', { id: '1', expiresAt: 2 });
    expect(ok.read('pending', 'c')).toEqual({ id: '1', expiresAt: 2 });
    ok.write('pending', 'c', null);
    expect(ok.read('pending', 'c')).toBeNull();
  });
});
