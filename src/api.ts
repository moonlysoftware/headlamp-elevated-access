/*
 * Copyright 2026 The headlamp-elevated-access authors
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default path the access broker is served under, on the same origin as Headlamp. */
export const DEFAULT_BROKER_BASE = '/elevated-access';
/** Header required on every mutating broker call (CSRF guard: forces a CORS preflight). */
export const CSRF_HEADER = 'X-Elevated-Access';
export const PLUGIN_NAME = 'headlamp-elevated-access';
const STORAGE_PREFIX = 'headlamp-elevated-access:';

export interface ElevatedCluster {
  id: string;
  label: string;
  /** Headlamp cluster names that show the Elevate button. */
  sourceClusters: string[];
  /** Headlamp cluster name that receives the elevated session cookie. */
  targetCluster: string;
  ttl: string;
}

export interface BrokerConfig {
  user?: string;
  /** Optional name of the approval system, shown to the user (for example "OpenBao"). */
  approvalSystem?: string;
  clusters: ElevatedCluster[];
}

export interface RequestView {
  id: string;
  cluster: string;
  /** Non-secret reference the requester can share with an approver. */
  reference?: string;
  approved: boolean;
  approvers: string[];
  expiresAt: number;
}

export interface InstallResult {
  cluster: string;
  targetCluster: string;
  expiresAt: number | null;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function normaliseBase(base?: string): string {
  const trimmed = (base || DEFAULT_BROKER_BASE).trim().replace(/\/+$/, '');
  if (!/^\/(?![/\\])[A-Za-z0-9._~\-/]*$/.test(trimmed) || trimmed.split('/').includes('..')) {
    // Same-origin paths only: never send cookies or requests to another host
    // (rejects absolute and protocol-relative URLs).
    return DEFAULT_BROKER_BASE;
  }
  return trimmed;
}

export function signInUrl(base: string): string {
  return `${base}/oauth2/start?rd=${encodeURIComponent(`${base}/signed-in`)}`;
}

export function createClient(fetchImpl: FetchLike, base: string = DEFAULT_BROKER_BASE) {
  const api = `${normaliseBase(base)}/api`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'same-origin', redirect: 'manual', headers };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers[CSRF_HEADER] = '1';
      init.body = JSON.stringify(body ?? {});
    }
    const resp = await fetchImpl(api + path, init);
    // An auth proxy answers API routes with 401 (or a redirect) when the session is missing.
    if (resp.type === 'opaqueredirect' || resp.status === 401 || resp.status === 0) {
      throw new ApiError(401, 'Sign in to request elevated access');
    }
    let data: any = {};
    try {
      data = await resp.json();
    } catch {
      data = {};
    }
    if (!resp.ok) {
      throw new ApiError(resp.status, data?.error || `Request failed (${resp.status})`);
    }
    return data as T;
  }

  return {
    config: () => call<BrokerConfig>('GET', '/config'),
    create: (cluster: string, reason: string) =>
      call<RequestView>('POST', '/requests', { cluster, reason }),
    status: (id: string) => call<RequestView>('GET', `/requests/${encodeURIComponent(id)}`),
    install: (id: string) =>
      call<InstallResult>('POST', `/requests/${encodeURIComponent(id)}/install`, {}),
    cancel: (id: string) => call<unknown>('DELETE', `/requests/${encodeURIComponent(id)}`, {}),
  };
}

export type BrokerClient = ReturnType<typeof createClient>;

/** Clears Headlamp's session cookie for a cluster so the user's own sign-in applies again. */
export async function dropElevation(fetchImpl: FetchLike, cluster: string): Promise<void> {
  const resp = await fetchImpl(`/clusters/${encodeURIComponent(cluster)}/set-token`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: '' }),
  });
  if (!resp.ok) {
    throw new ApiError(resp.status, 'Could not drop elevated access');
  }
}

export function findCluster(
  config: BrokerConfig | null | undefined,
  current: string | null | undefined
): ElevatedCluster | null {
  if (!config || !current) return null;
  return (
    (config.clusters || []).find(
      c => c.targetCluster === current || (c.sourceClusters || []).includes(current)
    ) || null
  );
}

export function formatRemaining(expiresAtSeconds: number, nowMs: number): string {
  const left = Math.floor((expiresAtSeconds * 1000 - nowMs) / 1000);
  if (left <= 0) return 'expired';
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}m ${s < 10 ? '0' : ''}${s}s`;
}

export interface PendingState {
  id: string;
  reference?: string;
  expiresAt: number;
}
export interface ActiveState {
  expiresAt: number | null;
}

/** Non-secret UI state. Tokens are never stored here. */
export function createStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const key = (kind: string, cluster: string) => `${STORAGE_PREFIX}${kind}:${cluster}`;
  function read<T>(kind: 'pending' | 'active', cluster: string): T | null {
    try {
      const raw = storage.getItem(key(kind, cluster));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
  function write(kind: 'pending' | 'active', cluster: string, value: unknown | null) {
    try {
      if (value === null) storage.removeItem(key(kind, cluster));
      else storage.setItem(key(kind, cluster), JSON.stringify(value));
    } catch {
      /* storage unavailable: state is lost on reload only */
    }
  }
  return { read, write };
}

export type UiStore = ReturnType<typeof createStore>;
