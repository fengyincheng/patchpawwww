import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * All mutable PatchPaw storage is rooted at one runtime home. Source files and
 * operation assets are intentionally outside this abstraction.
 */
export interface PatchPawPaths {
  home: string;

  data: string;
  communicationDb: string;
  controlPlaneDb: string;
  memory: string;
  state: string;
  outbox: string;

  secrets: string;
  providerSecrets: string;

  repos: string;
  workspaces: string;
  runs: string;
  snapshots: string;

  logs: string;
  cache: string;
  tmp: string;
  locks: string;
  backups: string;
}

/** Resolve the durable runtime home without depending on the source checkout. */
export function configuredRuntimeHome(value = process.env.PATCHPAW_HOME) {
  return resolve(value?.trim() || join(homedir(), '.patchpaw'));
}

export function patchpawPaths(home = configuredRuntimeHome()): PatchPawPaths {
  const runtimeHome = resolve(home);
  const data = join(runtimeHome, 'data');
  return {
    home: runtimeHome,
    data,
    communicationDb: join(data, 'communication.db'),
    controlPlaneDb: join(data, 'control-plane.db'),
    memory: join(data, 'memory'),
    state: join(data, 'state'),
    outbox: join(data, 'outbox'),
    secrets: join(runtimeHome, 'secrets'),
    providerSecrets: join(runtimeHome, 'secrets', 'providers'),
    repos: join(runtimeHome, 'repos'),
    workspaces: join(runtimeHome, 'workspaces'),
    runs: join(runtimeHome, 'runs'),
    snapshots: join(runtimeHome, 'snapshots'),
    logs: join(runtimeHome, 'logs'),
    cache: join(runtimeHome, 'cache'),
    tmp: join(runtimeHome, 'tmp'),
    locks: join(runtimeHome, 'locks'),
    backups: join(runtimeHome, 'backups'),
  };
}

/** Paths used only to inspect the pre-runtime-home layout during compatibility work. */
export function legacyRuntimePaths(home: string, legacyHome = process.env.PATCHPAW_LEGACY_HOME) {
  const legacyRoot = join(resolve(legacyHome?.trim() || home), 'var');
  return {
    root: legacyRoot,
    communicationDb: join(legacyRoot, 'communication.db'),
    state: join(legacyRoot, 'state'),
    memory: join(legacyRoot, 'memory'),
    outbox: join(legacyRoot, 'outbox'),
    inbound: join(legacyRoot, 'inbound'),
    repos: join(legacyRoot, 'repos'),
    workspaces: join(legacyRoot, 'workspaces'),
    runs: join(legacyRoot, 'runs'),
    snapshots: join(legacyRoot, 'snapshots'),
  };
}

/** Recover the runtime home from a path returned by CommunicationStore. */
export function runtimeHomeFromCommunicationDb(path: string) {
  return dirname(dirname(resolve(path)));
}
