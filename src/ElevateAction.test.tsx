/*
 * Copyright 2026 The headlamp-elevated-access authors
 * SPDX-License-Identifier: Apache-2.0
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, BrokerClient, createStore } from './api';
import { ElevateAction } from './ElevateAction';

const CONFIG = {
  approvalSystem: 'TestVault',
  clusters: [
    {
      id: 'staging',
      label: 'Staging',
      sourceClusters: ['staging'],
      targetCluster: 'staging',
      ttl: '30m',
    },
  ],
};

function memoryStore() {
  const mem = new Map<string, string>();
  return createStore({
    getItem: k => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: k => void mem.delete(k),
  });
}

function fakeClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    config: vi.fn().mockResolvedValue(CONFIG),
    create: vi.fn().mockResolvedValue({
      id: 'req-1',
      cluster: 'staging',
      reference: 'ref-123',
      approved: false,
      approvers: [],
      expiresAt: 2_000,
    }),
    status: vi.fn().mockResolvedValue({ approved: false, approvers: [] }),
    install: vi
      .fn()
      .mockResolvedValue({ cluster: 'staging', targetCluster: 'staging', expiresAt: 3_000 }),
    cancel: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as BrokerClient;
}

function setup(props: Partial<Parameters<typeof ElevateAction>[0]> = {}) {
  const store = props.store ?? memoryStore();
  const client = props.client ?? fakeClient();
  const reload = vi.fn();
  const drop = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <ElevateAction
      client={client}
      store={store}
      brokerBase="/elevated-access"
      currentCluster="staging"
      drop={drop}
      reload={reload}
      now={() => 1_000_000}
      {...props}
    />
  );
  return { ...utils, store, client, reload, drop };
}

describe('ElevateAction', () => {
  afterEach(() => vi.useRealTimers());

  it('renders nothing for clusters without elevated access', async () => {
    const { container, client } = setup({ currentCluster: 'production' });
    await waitFor(() => expect(client.config).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('requests access with a reason and shows the shareable reference', async () => {
    const { client, store } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Elevate' }));
    const submit = screen.getByRole('button', { name: 'Request access' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Restart the api pods' },
    });
    fireEvent.click(submit);
    expect(await screen.findByText('ref-123')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for an approver in TestVault/)).toBeInTheDocument();
    expect(client.create).toHaveBeenCalledWith('staging', 'Restart the api pods');
    expect(store.read('pending', 'staging')).toMatchObject({ id: 'req-1', reference: 'ref-123' });
  });

  it('installs automatically once approved and reloads', async () => {
    const store = memoryStore();
    store.write('pending', 'staging', { id: 'req-1', reference: 'ref-123', expiresAt: 2_000 });
    const client = fakeClient({
      status: vi.fn().mockResolvedValue({ approved: true, approvers: ['alice'] }),
    });
    const { reload } = setup({ store, client });
    await waitFor(() => expect(client.install).toHaveBeenCalledWith('req-1'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(store.read('pending', 'staging')).toBeNull();
    expect(store.read('active', 'staging')).toEqual({ expiresAt: 3_000 });
  });

  it('clears an expired pending request', async () => {
    const store = memoryStore();
    store.write('pending', 'staging', { id: 'req-1', expiresAt: 2_000 });
    const client = fakeClient({
      status: vi.fn().mockRejectedValue(new ApiError(404, 'Unknown request')),
    });
    setup({ store, client });
    await waitFor(() => expect(store.read('pending', 'staging')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Elevate' }));
    expect(screen.getByText(/expired or was cancelled/)).toBeInTheDocument();
  });

  it('returns to the user own access', async () => {
    const store = memoryStore();
    store.write('active', 'staging', { expiresAt: 1_600 });
    const { drop, reload } = setup({ store });
    fireEvent.click(await screen.findByRole('button', { name: /Elevated · 10m 00s/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Return to my own access' }));
    });
    expect(drop).toHaveBeenCalledWith('staging');
    expect(reload).toHaveBeenCalled();
    expect(store.read('active', 'staging')).toBeNull();
  });

  it('asks the user to sign in when the broker session is missing', async () => {
    const client = fakeClient({ config: vi.fn().mockRejectedValue(new ApiError(401, 'Sign in')) });
    setup({ client });
    fireEvent.click(await screen.findByRole('button', { name: 'Elevate' }));
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/elevated-access/oauth2/start?rd=%2Felevated-access%2Fsigned-in'
    );
  });
});
