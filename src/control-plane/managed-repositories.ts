import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patchpawPaths } from '../config/paths.ts';
import { normalizeRepositoryName } from './common.ts';

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

function repositoryFromRemote(value: string) {
  const source = value.trim().replace(/\.git$/, '');
  const match = source.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  if (!match) return undefined;
  try { return normalizeRepositoryName(match[1]); } catch { return undefined; }
}

/**
 * Discover only repositories represented by the current runtime. The legacy
 * /var tree is intentionally not inspected and PATCHPAW_GITHUB_TEST_REPO is not
 * treated as a managed repository record.
 */
export async function discoverManagedRepositories(runtimeHome: string) {
  const paths = patchpawPaths(runtimeHome);
  const names = new Set<string>();
  for (const entry of await entries(paths.repos)) {
    if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
    const config = await readFile(join(paths.repos, entry.name, 'config'), 'utf8').catch(() => '');
    const remote = config.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*([^\s]+)\s*(?:\n|$)/i)?.[1];
    const name = remote ? repositoryFromRemote(remote) : undefined;
    if (name) names.add(name);
  }
  for (const entry of await entries(paths.state)) {
    if (!entry.isDirectory()) continue;
    const separator = entry.name.indexOf('__');
    if (separator <= 0 || separator === entry.name.length - 2) continue;
    const directory = join(paths.state, entry.name);
    const records = await entries(directory);
    for (const record of records) {
      if (!record.isFile() || !record.name.endsWith('.json')) continue;
      let value: { repo?: unknown };
      try { value = JSON.parse(await readFile(join(directory, record.name), 'utf8')) as { repo?: unknown }; }
      catch { continue; }
      if (typeof value.repo !== 'string') continue;
      try { names.add(normalizeRepositoryName(value.repo)); }
      catch { /* a malformed historical state record is not a repository record */ }
    }
  }
  return [...names].sort();
}
