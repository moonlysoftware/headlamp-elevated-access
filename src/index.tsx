/*
 * Copyright 2026 The headlamp-elevated-access authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConfigStore,
  registerAppBarAction,
  registerPluginSettings,
  Utils,
} from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useLocation } from 'react-router-dom';
import {
  createClient,
  createStore,
  DEFAULT_BROKER_BASE,
  dropElevation,
  normaliseBase,
  PLUGIN_NAME,
} from './api';
import { ElevateAction } from './ElevateAction';

interface PluginConfig {
  brokerBase?: string;
}

const configStore = new ConfigStore<PluginConfig>(PLUGIN_NAME);
const useConfig = configStore.useConfig();
// localStorage: Headlamp's cookie is browser-wide, so every tab should show the same state.
const uiStore = createStore(window.localStorage);
const fetchImpl = window.fetch.bind(window);

function ConnectedElevateAction() {
  useLocation(); // re-render on navigation
  const brokerBase = normaliseBase(useConfig()?.brokerBase);
  const client = React.useMemo(() => createClient(fetchImpl, brokerBase), [brokerBase]);
  return (
    <ElevateAction
      client={client}
      store={uiStore}
      brokerBase={brokerBase}
      currentCluster={Utils.getCluster()}
      drop={cluster => dropElevation(fetchImpl, cluster)}
      reload={() => window.location.reload()}
    />
  );
}

registerAppBarAction(ConnectedElevateAction);

function Settings(props: { data?: PluginConfig; onDataChange?: (data: PluginConfig) => void }) {
  return (
    <Box sx={{ maxWidth: 480 }}>
      <Typography variant="body2" paragraph>
        Path of the access broker on this Headlamp host. It must be served from the same origin as
        Headlamp.
      </Typography>
      <TextField
        label="Broker path"
        fullWidth
        defaultValue={props.data?.brokerBase ?? DEFAULT_BROKER_BASE}
        onChange={e => props.onDataChange?.({ ...props.data, brokerBase: e.target.value })}
      />
    </Box>
  );
}

registerPluginSettings(PLUGIN_NAME, Settings, true);
