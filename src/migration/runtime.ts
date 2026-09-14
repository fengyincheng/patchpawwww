import { cp, mkdir, readdir, readFile, readlink, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { legacyRuntimePaths, patchpawPaths } from '../config/paths.ts';
import { disposeWorkspacePath, repoCachePath, withRepoLock } from '../workspace/repo-store.ts';
import { git } from '../workspace/git.ts';
import { withCutoverSourceLock, withRuntimeLock } from './runtime-lock.ts';

const terminalStatuses = new Set([
  'already_completed', 'ci_completed', 'ci_still_red', 'closed', 'conflict_completed', 'custom_completed',
  'conversation_completed', 'harness_failed', 'model_output_truncated', 'needs_human', 'provider_unavailable',
  'repair_failed', 'review_completed', 'stopped',
]);

export interface CommunicationSummary {
  integrity: string;
  journalMode: string;
  meta: Record<string, string>;
  outbound: number;
  inbound: number;
  walBytes: number;
}

export interface RuntimeWorkspace {
  path: string;
  runId: string;
  repo?: string;
  disposition: 'paused' | 'terminal' | 'unknown';
  status?: string;
  manifestPath?: string;
  statePath?: string;
}

export interface LegacyRuntimeInventory {
  legacyHome: string;
  legacyRoot: string;
  stateFiles: number;
  memoryDbs: number;
  runDirs: number;
  snapshotFiles: number;
  repoDirs: number;
  workspaceDirs: number;
  outboxFiles: number;
  inboundFiles: number;
  activeWorkers: Array<{ path: string; pid: number }>;
  workspaces: RuntimeWorkspace[];
  communication?: CommunicationSummary;
}

export interface RuntimeMigrationReport {
  before: LegacyRuntimeInventory;
  legacyArchivedRoot: string;
  removedTerminalWorkspaces: string[];
  cleanupErrors: string[];
  after: {
    runtimeHome: string;
    stateFiles: number;
    memoryDbs: number;
    runDirs: number;
    snapshotFiles: number;
    repoDirs: number;
    workspaceDirs: number;
    outboxFiles: number;
    communication?: CommunicationSummary;
  };
}

async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function countFiles(path: string, predicate: (name: string) => boolean = () => true): Promise<number> {
  let count = 0;
  for (const entry of await entries(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) count += await countFiles(child, predicate);
    else if (entry.isFile() && predicate(entry.name)) count++;
  }
  return count;
}

async function countDirectories(path: string) {
  return (await entries(path)).filter(entry => entry.isDirectory()).length;
}

async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readCommunication(path: string): Promise<CommunicationSummary | undefined> {
  if (!await exists(path)) return undefined;
  const client = createClient({ url: pathToFileURL(path).href });
  try {
    const rows = async (sql: string) => (await client.execute(sql)).rows;
    const integrity = String((await rows('PRAGMA integrity_check'))[0]?.integrity_check ?? '');
    const journalMode = String((await rows('PRAGMA journal_mode'))[0]?.journal_mode ?? '');
    const meta: Record<string, string> = {};
    for (const row of await rows('SELECT key, value FROM communication_meta ORDER BY key')) {
      meta[String(row.key)] = String(row.value);
    }
    const outbound = Number((await rows('SELECT COUNT(*) AS count FROM outbound_delivery'))[0]?.count ?? 0);
    const inbound = Number((await rows('SELECT COUNT(*) AS count FROM inbound_comment'))[0]?.count ?? 0);
    let walBytes = 0;
    try { walBytes = (await stat(`${path}-wal`)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { integrity, journalMode, meta, outbound, inbound, walBytes };
  } finally { client.close(); }
}

async function stateFacts(stateRoot: string) {
  const files: Array<{ path: string; value: Record<string, unknown> }> = [];
  const paused: Array<{ path: string; workspace: string; runId: string }> = [];
  const activeWorkers: Array<{ path: string; pid: number }> = [];
  for (const repoDir of await entries(stateRoot)) {
    if (!repoDir.isDirectory()) continue;
    const directory = join(stateRoot, repoDir.name);
    for (const file of await entries(directory)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const path = join(directory, file.name);
      const value = await jsonFile(path);
      if (!value) continue;
      files.push({ path, value });
      if (file.name.endsWith('.paused.json')) {
        const workspace = value.workspace as Record<string, unknown> | undefined;
        if (typeof workspace?.path === 'string' && typeof value.run_id === 'string') {
          paused.push({ path, workspace: resolve(workspace.path), runId: value.run_id });
        }
      } else if (value.active === true) {
        if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
          throw new Error(`Cannot verify active worker marker before migration: ${path}`);
        }
        activeWorkers.push({ path, pid: Number(value.pid) });
      }
    }
  }
  return { files, paused, activeWorkers };
}

function pathContains(root: string, candidate: string) {
  const base = resolve(root).replaceAll('\\', '/');
  return candidate.split(/\0|\n/).some(value => {
    const trimmed = value.trim().replaceAll('\\', '/');
    return trimmed === base || trimmed.startsWith(`${base}/`) || trimmed.includes(`=${base}`) || trimmed.includes(` ${base}`);
  });
}

function isWithin(root: string, candidate: string) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function processParent(pid: number) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/);
    return Number(fields[1]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function processAncestors() {
  const ancestors = new Set<number>([process.pid]);
  let pid = process.pid;
  while (pid > 1) {
    const parent = await processParent(pid);
    if (!parent || !Number.isSafeInteger(parent) || parent <= 0 || ancestors.has(parent)) break;
    ancestors.add(parent);
    pid = parent;
  }
  return ancestors;
}

/**
 * The source lock is shared by cooperating cutover processes. Legacy workers
 * predate that lock, so migration also fails closed when any process still
 * advertises or has an open path under the legacy runtime root. This is a
 * second guard, not a claim that an old binary can be force-locked.
 */
async function assertNoLegacyRuntimeProcesses(legacyRoot: string) {
  // Linux exposes cwd, environment, and open descriptors through /proc. On
  // Windows/macOS there is no equally portable descriptor inventory; active
  // state markers and the cutover locks remain the authoritative checks.
  if (process.platform !== 'linux') return;
  const procEntries = await readdir('/proc', { withFileTypes: true }).catch(error => {
    throw new Error(`Cannot inspect legacy worker processes before migration: ${(error as Error).message}`);
  });
  const ancestors = await processAncestors();
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (ancestors.has(pid)) continue;
    const values: string[] = [];
    for (const path of [`/proc/${pid}/cmdline`, `/proc/${pid}/environ`]) {
      try { values.push((await readFile(path)).toString('utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot inspect legacy worker process ${pid}: ${(error as Error).message}`);
      }
    }
    try { values.push(await readlink(`/proc/${pid}/cwd`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot inspect legacy worker process ${pid}: ${(error as Error).message}`);
    }
    try {
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try { values.push(await readlink(`/proc/${pid}/fd/${fd}`)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot inspect legacy worker process ${pid}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot inspect legacy worker process ${pid}: ${(error as Error).message}`);
    }
    if (values.some(value => pathContains(legacyRoot, value))) {
      throw new Error(`Legacy runtime process ${pid} still references ${legacyRoot}; refusing migration`);
    }
  }
}

async function runFacts(runsRoot: string) {
  const runs = new Map<string, { manifest?: Record<string, unknown>; result?: Record<string, unknown> }>();
  for (const entry of await entries(runsRoot)) {
    if (!entry.isDirectory()) continue;
    const directory = join(runsRoot, entry.name);
    runs.set(entry.name, {
      manifest: await jsonFile(join(directory, 'manifest.json')),
      result: await jsonFile(join(directory, 'result.json')),
    });
  }
  return runs;
}

export async function inspectLegacyRuntime(legacyHome: string, runtimeHome?: string): Promise<LegacyRuntimeInventory> {
  const legacy = legacyRuntimePaths(runtimeHome ?? legacyHome, legacyHome);
  const state = await stateFacts(legacy.state);
  const runs = await runFacts(legacy.runs);
  const pausedByPath = new Map(state.paused.map(value => [value.workspace, value]));
  const workspaces: RuntimeWorkspace[] = [];
  for (const entry of await entries(legacy.workspaces)) {
    if (!entry.isDirectory()) continue;
    const path = resolve(join(legacy.workspaces, entry.name));
    const run = runs.get(entry.name);
    const manifestPath = join(legacy.runs, entry.name, 'manifest.json');
    const manifest = run?.manifest;
    const resultStatus = typeof run?.result?.status === 'string' ? run.result.status : undefined;
    const stateEntry = state.files.find(({ value }) => value.run_id === entry.name && !value.closed_at);
    const stateStatus = typeof stateEntry?.value.phase === 'string' ? stateEntry.value.phase : undefined;
    const paused = pausedByPath.get(path);
    const status = resultStatus ?? stateStatus;
    workspaces.push({
      path,
      runId: entry.name,
      repo: typeof manifest?.repo === 'string' ? manifest.repo : undefined,
      disposition: paused ? 'paused' : status && terminalStatuses.has(status) ? 'terminal' : 'unknown',
      status,
      manifestPath: await exists(manifestPath) ? manifestPath : undefined,
      statePath: stateEntry?.path,
    });
  }
  return {
    legacyHome: resolve(legacyHome),
    legacyRoot: legacy.root,
    stateFiles: state.files.length,
    memoryDbs: await countFiles(legacy.memory, name => name.endsWith('.db')),
    runDirs: await countDirectories(legacy.runs),
    snapshotFiles: await countFiles(legacy.snapshots),
    repoDirs: await countDirectories(legacy.repos),
    workspaceDirs: workspaces.length,
    outboxFiles: await countFiles(legacy.outbox),
    inboundFiles: await countFiles(legacy.inbound),
    activeWorkers: state.activeWorkers,
    workspaces,
    communication: await readCommunication(legacy.communicationDb),
  };
}

async function checkpointSqliteDatabase(path: string, label: string) {
  const client = createClient({ url: pathToFileURL(path).href });
  try {
    const integrity = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
    if (integrity !== 'ok') throw new Error(`${label} integrity check failed: ${integrity}`);
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { client.close(); }
  let walBytes = 0;
  try { walBytes = (await stat(`${path}-wal`)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (walBytes !== 0) throw new Error(`${label} WAL was not checkpointed: ${walBytes} bytes remain`);
}

export async function checkpointCommunicationDatabase(path: string) {
  return checkpointSqliteDatabase(path, 'communication.db');
}

async function copyDirectoryContents(source: string, destination: string) {
  if (!await exists(source)) throw new Error(`Required runtime directory is missing: ${source}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await entries(source)) {
    await cp(join(source, entry.name), join(destination, entry.name), { recursive: true, force: false, errorOnExist: true });
  }
}

async function copySqliteDatabase(source: string, destination: string) {
  const sourceClient = createClient({ url: pathToFileURL(source).href, timeout: 5000 });
  try {
    const integrity = String((await sourceClient.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed for ${source}: ${integrity}`);
    await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
    await sourceClient.execute(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally { sourceClient.close(); }
  const destinationClient = createClient({ url: pathToFileURL(destination).href, timeout: 5000 });
  try {
    const integrity = String((await destinationClient.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? '');
    if (integrity !== 'ok') throw new Error(`SQLite migrated database integrity check failed for ${destination}: ${integrity}`);
  } finally { destinationClient.close(); }
  const { chmod } = await import('node:fs/promises');
  await chmod(destination, 0o600);
}

async function copyMemoryDatabases(source: string, destination: string) {
  if (!await exists(source)) throw new Error(`Required runtime directory is missing: ${source}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await entries(source)) {
    if (!entry.isFile() || !entry.name.endsWith('.db')) {
      if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
      throw new Error(`Unsupported memory runtime entry: ${join(source, entry.name)}`);
    }
    await copySqliteDatabase(join(source, entry.name), join(destination, entry.name));
  }
}

async function ensureEmptyDestination(path: string) {
  const current = await entries(path);
  if (current.length) throw new Error(`Runtime destination must be absent or empty: ${path}`);
}

async function quarantineTerminalWorkspaces(legacyRoot: string, workspaces: RuntimeWorkspace[]) {
  const quarantineRoot = join(legacyRoot, `.patchpaw-migration-workspaces-${randomUUID()}`);
  const moved: Array<{ source: string; quarantine: string }> = [];
  try {
    for (const workspace of workspaces) {
      const relativePath = relative(legacyRoot, workspace.path);
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Terminal workspace escapes the legacy runtime root: ${workspace.path}`);
      }
      const quarantine = join(quarantineRoot, relativePath);
      await mkdir(join(quarantine, '..'), { recursive: true, mode: 0o700 });
      await rename(workspace.path, quarantine);
      moved.push({ source: workspace.path, quarantine });
    }
    return { quarantineRoot, moved };
  } catch (error) {
    try { await restoreQuarantinedWorkspaces(quarantineRoot, moved); }
    catch (restoreError) {
      throw new Error(`Terminal workspace quarantine failed and recovery is incomplete; inspect ${quarantineRoot}: ${(restoreError as Error).message}`, { cause: error });
    }
    throw error;
  }
}

async function restoreQuarantinedWorkspaces(quarantineRoot: string, moved: Array<{ source: string; quarantine: string }>) {
  const failures: string[] = [];
  for (const item of [...moved].reverse()) {
    try {
      if (!await exists(item.quarantine)) continue;
      if (await exists(item.source)) throw new Error(`source path already exists: ${item.source}`);
      await mkdir(join(item.source, '..'), { recursive: true, mode: 0o700 });
      await rename(item.quarantine, item.source);
    } catch (error) { failures.push(`${item.source}: ${(error as Error).message}`); }
  }
  if (failures.length) throw new Error(failures.join('; '));
  await rm(quarantineRoot, { recursive: true, force: true });
}

async function pruneStagedTerminalWorktrees(stagingRoot: string, workspaces: RuntimeWorkspace[]) {
  const repos = new Set(workspaces.flatMap(workspace => workspace.repo ? [workspace.repo] : []));
  for (const repo of repos) {
    const cache = repoCachePath(stagingRoot, repo);
    await withRepoLock(cache, async () => {
      await git(cache, ['worktree', 'prune', '--expire=now']);
    });
  }
}

async function runtimeSourceFingerprint(root: string, paths: string[]) {
  const facts: string[] = [];
  const visit = async (path: string) => {
    if (path.endsWith('-shm')) return;
    let info;
    try { info = await stat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { facts.push(`${relative(root, path)}:missing`); return; }
      throw error;
    }
    if (path.endsWith('-wal') && info.isFile() && info.size === 0) {
      facts.push(`${relative(root, path)}:missing`);
      return;
    }
    const kind = info.isDirectory() ? 'd' : info.isFile() ? 'f' : 'other';
    const digest = info.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex') : '';
    facts.push(`${relative(root, path)}:${kind}:${info.size}:${digest}`);
    if (info.isDirectory()) {
      const children = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) await visit(join(path, child.name));
    }
  };
  for (const path of paths) await visit(path);
  return facts.join('\n');
}

function fingerprintDiff(before: string, after: string) {
  const left = new Set(before.split('\n'));
  const right = new Set(after.split('\n'));
  return [...new Set([...left].filter(value => !right.has(value)).concat([...right].filter(value => !left.has(value))))].slice(0, 12);
}

interface CutoverJournal {
  version: 1;
  runtimeHome: string;
  legacyRoot: string;
  stagingRoot: string;
  archivedLegacyRoot: string;
  state: 'prepared' | 'source_archived' | 'published';
}

async function writeCutoverJournal(path: string, journal: CutoverJournal) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function validCutoverPath(value: unknown, expected: string) {
  return typeof value === 'string' && resolve(value) === expected;
}

/** Recover the two-rename window before a new migration starts. No data is discarded. */
async function recoverOrphanedWorkspaceQuarantines(legacyRoot: string) {
  for (const entry of await entries(legacyRoot)) {
    if (!entry.isDirectory() || !entry.name.startsWith('.patchpaw-migration-workspaces-')) continue;
    const quarantineRoot = join(legacyRoot, entry.name);
    const quarantinedWorkspaces = join(quarantineRoot, 'workspaces');
    for (const workspace of await entries(quarantinedWorkspaces)) {
      if (!workspace.isDirectory()) throw new Error(`Unsupported orphaned workspace quarantine entry: ${join(quarantinedWorkspaces, workspace.name)}`);
      const target = join(legacyRoot, 'workspaces', workspace.name);
      if (await exists(target)) throw new Error(`Cannot recover orphaned workspace quarantine; target exists: ${target}`);
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      await rename(join(quarantinedWorkspaces, workspace.name), target);
    }
    if ((await entries(quarantinedWorkspaces)).length) throw new Error(`Orphaned workspace quarantine is not empty: ${quarantinedWorkspaces}`);
    await rm(quarantineRoot, { recursive: true, force: true });
  }
}

async function recoverInterruptedMigration(runtimeHome: string, legacyRoot: string) {
  const parent = join(runtimeHome, '..');
  const prefix = `${basename(resolve(runtimeHome))}.migration-`;
  for (const entry of await entries(parent)) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.journal.json')) continue;
    const journalPath = join(parent, entry.name);
    let journal: CutoverJournal;
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as CutoverJournal; }
    catch (error) { throw new Error(`Cannot recover migration journal ${journalPath}: ${(error as Error).message}`); }
    const stagingRoot = typeof journal.stagingRoot === 'string' ? resolve(journal.stagingRoot) : '';
    const archivedLegacyRoot = typeof journal.archivedLegacyRoot === 'string' ? resolve(journal.archivedLegacyRoot) : '';
    if (journal.version !== 1 || !validCutoverPath(journal.runtimeHome, resolve(runtimeHome))
      || !validCutoverPath(journal.legacyRoot, resolve(legacyRoot))
      || !isWithin(parent, stagingRoot) || !isWithin(parent, archivedLegacyRoot)
      || !['prepared', 'source_archived', 'published'].includes(journal.state)) {
      throw new Error(`Unsupported migration journal: ${journalPath}`);
    }
    const runtimeExists = await exists(runtimeHome);
    const archiveExists = await exists(archivedLegacyRoot);
    const legacyExists = await exists(legacyRoot);
    if (runtimeExists) {
      if (journal.state === 'prepared' || !await exists(join(runtimeHome, 'data', 'communication.db'))) {
        throw new Error(`Migration journal does not prove a complete published runtime: ${journalPath}`);
      }
      await rm(stagingRoot, { recursive: true, force: true });
      await unlink(journalPath);
      continue;
    }
    if (archiveExists && legacyExists) throw new Error(`Migration journal has both legacy source and archive: ${journalPath}`);
    if (archiveExists && !legacyExists) await rename(archivedLegacyRoot, legacyRoot);
    if (await exists(legacyRoot)) {
      await rm(stagingRoot, { recursive: true, force: true });
      await unlink(journalPath);
      continue;
    }
    throw new Error(`Cannot recover migration journal without legacy source: ${journalPath}`);
  }
}

async function runtimeCounts(runtimeHome: string) {
  const paths = patchpawPaths(runtimeHome);
  return {
    runtimeHome: paths.home,
    stateFiles: (await stateFacts(paths.state)).files.length,
    memoryDbs: await countFiles(paths.memory, name => name.endsWith('.db')),
    runDirs: await countDirectories(paths.runs),
    snapshotFiles: await countFiles(paths.snapshots),
    repoDirs: await countDirectories(paths.repos),
    workspaceDirs: await countDirectories(paths.workspaces),
    outboxFiles: await countFiles(paths.outbox),
    communication: await readCommunication(paths.communicationDb),
  };
}

export async function migrateRuntime(options: {
  legacyHome: string;
  runtimeHome: string;
  cleanupTerminalWorkspaces: boolean;
}): Promise<RuntimeMigrationReport> {
  const legacyHome = resolve(options.legacyHome);
  const runtimeHome = resolve(options.runtimeHome);
  const migrate = () => withCutoverSourceLock(legacyHome, 'exclusive', true, () => withCutoverSourceLock(runtimeHome, 'exclusive', true, async () => {
    const source = legacyRuntimePaths(runtimeHome, legacyHome);
    await recoverOrphanedWorkspaceQuarantines(source.root);
    await recoverInterruptedMigration(runtimeHome, source.root);
    await assertNoLegacyRuntimeProcesses(source.root);
    const before = await inspectLegacyRuntime(legacyHome, runtimeHome);
    if (before.activeWorkers.length) throw new Error(`Active PatchPaw workers found: ${JSON.stringify(before.activeWorkers)}`);
    const paused = before.workspaces.filter(value => value.disposition === 'paused');
    if (paused.length) throw new Error(`Paused workspaces require an explicit relocation decision: ${paused.map(value => value.path).join(', ')}`);
    const unknown = before.workspaces.filter(value => value.disposition === 'unknown');
    if (unknown.length) throw new Error(`Workspace disposition is unknown; refusing migration: ${unknown.map(value => value.path).join(', ')}`);
    for (const workspace of before.workspaces.filter(value => value.disposition === 'terminal')) {
      if (!workspace.repo) throw new Error(`Terminal workspace has no repository in its manifest: ${workspace.path}`);
    }
    if (before.workspaces.some(value => value.disposition === 'terminal') && !options.cleanupTerminalWorkspaces) {
      throw new Error('Terminal workspace residue requires Git-aware cleanup before migration');
    }
    await ensureEmptyDestination(runtimeHome);

    const removedTerminalWorkspaces: string[] = [];
    const cleanupErrors: string[] = [];
    const communication = before.communication;
    if (!communication) throw new Error('Legacy communication.db is missing');
    if (communication.integrity !== 'ok') throw new Error(`Legacy communication.db integrity check failed: ${communication.integrity}`);
    if (!communication.meta.schema_version || !communication.meta.file_queue_import_v1) {
      throw new Error('Legacy communication.db has not completed the file queue import; refusing to omit legacy queue data');
    }
    await checkpointCommunicationDatabase(source.communicationDb);
    for (const entry of await entries(source.memory)) {
      if (entry.isFile() && entry.name.endsWith('.db')) await checkpointSqliteDatabase(join(source.memory, entry.name), `memory database ${entry.name}`);
    }

    const sourceFingerprint = await runtimeSourceFingerprint(legacyHome, [source.communicationDb,
      `${source.communicationDb}-wal`,
      source.memory, source.state, source.outbox, source.repos, source.runs, source.snapshots]);
    // Build the complete destination beside runtimeHome and publish it with one
    // rename. A failed copy therefore cannot leave a partially migrated home.
    const stagingRoot = `${runtimeHome}.migration-${randomUUID()}`;
    const archivedLegacyRoot = `${source.root}.migrated-${randomUUID()}`;
    const journalPath = `${stagingRoot}.journal.json`;
    const destination = patchpawPaths(stagingRoot);
    let promoted = false;
    try {
      await writeCutoverJournal(journalPath, { version: 1, runtimeHome, legacyRoot: source.root, stagingRoot,
        archivedLegacyRoot, state: 'prepared' });
      await mkdir(destination.home, { recursive: true, mode: 0o700 });
      for (const path of [destination.data, destination.memory, destination.state, destination.outbox,
        destination.repos, destination.workspaces, destination.runs, destination.snapshots,
        destination.logs, destination.cache, destination.tmp, destination.locks]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
      await copyMemoryDatabases(source.memory, destination.memory);
      await copyDirectoryContents(source.state, destination.state);
      if (await exists(source.outbox)) await copyDirectoryContents(source.outbox, destination.outbox);
      await copyDirectoryContents(source.repos, destination.repos);
      await copyDirectoryContents(source.runs, destination.runs);
      await copyDirectoryContents(source.snapshots, destination.snapshots);
      await copySqliteDatabase(source.communicationDb, destination.communicationDb);
      await checkpointCommunicationDatabase(source.communicationDb);
      for (const entry of await entries(source.memory)) {
        if (entry.isFile() && entry.name.endsWith('.db')) await checkpointSqliteDatabase(join(source.memory, entry.name), `memory database ${entry.name}`);
      }
      await assertNoLegacyRuntimeProcesses(source.root);
      const terminal = before.workspaces.filter(value => value.disposition === 'terminal');
      const quarantine = terminal.length ? await quarantineTerminalWorkspaces(source.root, terminal) : undefined;
      try {
        if (quarantine) await pruneStagedTerminalWorktrees(stagingRoot, terminal);
      } finally {
        if (quarantine) await restoreQuarantinedWorkspaces(quarantine.quarantineRoot, quarantine.moved);
      }
      const afterFingerprint = await runtimeSourceFingerprint(legacyHome, [source.communicationDb,
        `${source.communicationDb}-wal`,
        source.memory, source.state, source.outbox, source.repos, source.runs, source.snapshots]);
      if (afterFingerprint !== sourceFingerprint) {
        throw new Error(`Legacy runtime changed during migration; refusing to publish partial evidence: ${JSON.stringify(fingerprintDiff(sourceFingerprint, afterFingerprint))}`);
      }
      await assertNoLegacyRuntimeProcesses(source.root);
      if (await exists(archivedLegacyRoot)) throw new Error(`Legacy migration archive already exists: ${archivedLegacyRoot}`);
      // Atomically remove the old runtime path only after the complete staged
      // copy and source fingerprint have passed. A legacy worker that does not
      // know the new lock can no longer reopen the old runtime path during the
      // final cutover; the archive remains available for recovery.
      await rename(source.root, archivedLegacyRoot);
      // Recheck both names after the rename: an already-open legacy FD now
      // points at the archive even though its process metadata still names the
      // old path. If the old path reappears, fail closed rather than overwrite it.
      await assertNoLegacyRuntimeProcesses(source.root);
      await assertNoLegacyRuntimeProcesses(archivedLegacyRoot);
      if (await exists(source.root)) throw new Error(`Legacy runtime path was recreated during cutover: ${source.root}`);
      await writeCutoverJournal(journalPath, { version: 1, runtimeHome, legacyRoot: source.root, stagingRoot,
        archivedLegacyRoot, state: 'source_archived' });
      await rename(destination.home, runtimeHome);
      promoted = true;
      await writeCutoverJournal(journalPath, { version: 1, runtimeHome, legacyRoot: source.root, stagingRoot,
        archivedLegacyRoot, state: 'published' }).catch(error => cleanupErrors.push(`cutover journal: ${(error as Error).message}`));
      for (const workspace of before.workspaces.filter(value => value.disposition === 'terminal')) {
        const archivedWorkspace = join(archivedLegacyRoot, relative(source.root, workspace.path));
        try {
          await disposeWorkspacePath(archivedLegacyRoot, workspace.repo!, archivedWorkspace);
          removedTerminalWorkspaces.push(workspace.path);
        } catch (error) {
          cleanupErrors.push(`${workspace.path}: ${(error as Error).message}`);
        }
      }
      await unlink(journalPath).catch(error => cleanupErrors.push(`cutover journal cleanup: ${(error as Error).message}`));
      return { before, legacyArchivedRoot: archivedLegacyRoot, removedTerminalWorkspaces, cleanupErrors, after: await runtimeCounts(runtimeHome) };
    } finally {
      if (!promoted) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        if (await exists(archivedLegacyRoot)) {
          if (await exists(source.root)) throw new Error(`Cannot restore legacy runtime path after failed migration: ${source.root}`);
          await rename(archivedLegacyRoot, source.root);
        }
        await unlink(journalPath).catch(() => undefined);
      }
    }
  }));
  return migrate();
}
