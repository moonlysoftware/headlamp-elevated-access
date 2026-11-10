/*
 * Copyright 2026 The headlamp-elevated-access authors
 * SPDX-License-Identifier: Apache-2.0
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  ActiveState,
  ApiError,
  BrokerClient,
  BrokerConfig,
  findCluster,
  formatRemaining,
  PendingState,
  signInUrl,
  UiStore,
} from './api';

const POLL_MS = 5000;
const REASON_MIN = 8;
const REASON_MAX = 280;

export interface ElevateActionProps {
  client: BrokerClient;
  store: UiStore;
  brokerBase: string;
  currentCluster: string | null;
  /** Clears Headlamp's cookie for the target cluster. */
  drop: (cluster: string) => Promise<void>;
  reload: () => void;
  now?: () => number;
}

function useNow(active: boolean, now: () => number) {
  const [value, setValue] = React.useState(now());
  React.useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setValue(now()), 1000);
    return () => clearInterval(t);
  }, [active, now]);
  return value;
}

export function ElevateAction(props: ElevateActionProps) {
  const { client, store, brokerBase, currentCluster, drop, reload } = props;
  const nowFn = props.now ?? Date.now;
  const [config, setConfig] = React.useState<BrokerConfig | null>(null);
  const [needsSignIn, setNeedsSignIn] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [pending, setPending] = React.useState<PendingState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const cluster = findCluster(config, currentCluster);
  const target = cluster?.targetCluster ?? null;
  const active = target ? store.read<ActiveState>('active', target) : null;
  const now = useNow(!!active || !!pending, nowFn);

  React.useEffect(() => {
    if (!currentCluster) return;
    let cancelled = false;
    client.config().then(
      cfg => !cancelled && setConfig(cfg),
      (err: ApiError) => !cancelled && err.status === 401 && setNeedsSignIn(true)
    );
    return () => {
      cancelled = true;
    };
  }, [client, currentCluster]);

  React.useEffect(() => {
    setPending(cluster ? store.read<PendingState>('pending', cluster.id) : null);
  }, [cluster?.id]);

  const fail = React.useCallback((err: unknown) => {
    setBusy(false);
    if (err instanceof ApiError && err.status === 401) setNeedsSignIn(true);
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  // Poll the approval status while a request is pending; install as soon as it is approved.
  React.useEffect(() => {
    if (!pending || !cluster) return undefined;
    let stopped = false;
    const tick = () => {
      client.status(pending.id).then(
        view => {
          if (stopped || !view.approved) return;
          stopped = true;
          setBusy(true);
          client.install(pending.id).then(result => {
            store.write('pending', cluster.id, null);
            store.write('active', cluster.targetCluster, { expiresAt: result.expiresAt });
            reload();
          }, fail);
        },
        (err: ApiError) => {
          if (stopped) return;
          if (err.status === 404) {
            stopped = true;
            store.write('pending', cluster.id, null);
            setPending(null);
            setError('The request expired or was cancelled.');
          }
        }
      );
    };
    const t = setInterval(tick, POLL_MS);
    tick();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [pending?.id, cluster?.id]);

  if (!cluster && !needsSignIn) return null;

  const approvalSystem = config?.approvalSystem;

  function submit() {
    if (!cluster) return;
    setError(null);
    setBusy(true);
    client.create(cluster.id, reason).then(view => {
      setBusy(false);
      const p: PendingState = { id: view.id, reference: view.reference, expiresAt: view.expiresAt };
      store.write('pending', cluster.id, p);
      setPending(p);
    }, fail);
  }

  function cancel() {
    if (!pending || !cluster) return;
    client
      .cancel(pending.id)
      .catch(() => undefined)
      .then(() => {
        store.write('pending', cluster.id, null);
        setPending(null);
      });
  }

  function returnToOwnAccess() {
    if (!target) return;
    drop(target).then(() => {
      store.write('active', target, null);
      reload();
    }, fail);
  }

  let label = 'Elevate';
  if (active) {
    label = active.expiresAt ? `Elevated · ${formatRemaining(active.expiresAt, now)}` : 'Elevated';
  } else if (pending) {
    label = 'Awaiting approval';
  }

  let body: React.ReactNode;
  if (needsSignIn && !config) {
    body = (
      <Box>
        <Typography paragraph>
          Sign in to the access broker first. It uses your single sign-on session.
        </Typography>
        <Button variant="contained" href={signInUrl(brokerBase)} target="_blank" rel="noopener">
          Sign in
        </Button>
        <Typography variant="body2" sx={{ mt: 1 }}>
          Then close that tab and reload this page.
        </Typography>
      </Box>
    );
  } else if (active && cluster) {
    body = (
      <Box>
        <Typography paragraph>
          You are using the approved elevated credential for {cluster.label}.
          {active.expiresAt ? ` It expires in ${formatRemaining(active.expiresAt, now)}.` : ''}
        </Typography>
        <Button variant="outlined" onClick={returnToOwnAccess}>
          Return to my own access
        </Button>
      </Box>
    );
  } else if (pending) {
    body = (
      <Box>
        <Typography paragraph>
          Waiting for an approver{approvalSystem ? ` in ${approvalSystem}` : ''}. Headlamp switches
          to the elevated credential automatically once the request is approved.
        </Typography>
        {pending.reference ? (
          <Typography variant="body2" paragraph>
            Request reference (safe to share with the approver): <code>{pending.reference}</code>
          </Typography>
        ) : null}
        <Typography variant="body2" paragraph>
          Request expires in {formatRemaining(pending.expiresAt, now)}.
        </Typography>
        <Button variant="outlined" onClick={cancel} disabled={busy}>
          Cancel request
        </Button>
      </Box>
    );
  } else if (cluster) {
    body = (
      <Box>
        <Typography paragraph>
          Request temporary elevated access to {cluster.label} ({cluster.ttl}). An approver must
          approve the request{approvalSystem ? ` in ${approvalSystem}` : ''}.
        </Typography>
        <TextField
          label="Reason"
          fullWidth
          multiline
          minRows={2}
          inputProps={{ maxLength: REASON_MAX }}
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <Button
          variant="contained"
          sx={{ mt: 2 }}
          onClick={submit}
          disabled={busy || reason.trim().length < REASON_MIN}
        >
          Request access
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Button
        color={active ? 'warning' : 'inherit'}
        variant={active ? 'contained' : 'text'}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Elevated access</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : null}
          {body}
        </DialogContent>
      </Dialog>
    </>
  );
}
