import { listRunManifests } from '../src/observability/run-resolver.ts';
import { parseRunsArgs } from '../src/observability/cli-options.ts';
import { renderRunList } from '../src/observability/renderer.ts';

function isFailed(status: string | undefined) {
  return !!status && !status.endsWith('_completed') && !['already_completed', 'closed'].includes(status);
}

async function main() {
  const options = parseRunsArgs(process.argv.slice(2));
  if (options.help) { console.log('Usage: npm run agent:runs -- [--failed] [--limit N] [--repo owner/repo] [--include-corrupt] [--compact|--verbose|--json]'); return; }
  let runs = await listRunManifests();
  if (!options.includeCorrupt) runs = runs.filter(run => !run.error);
  if (options.repo) runs = runs.filter(run => [run.manifest?.repo, run.manifest?.repository, run.manifest?.repository_path, run.manifest?.path_with_namespace, run.manifest?.full_name]
    .some(value => value === options.repo));
  if (options.failed) runs = runs.filter(run => isFailed(typeof run.result?.status === 'string' ? run.result.status : undefined));
  runs = runs.slice(0, options.limit);
  for (const line of renderRunList(runs, options.mode)) console.log(line);
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
