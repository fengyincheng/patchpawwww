import { loadConfig } from '../src/config/env.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { hasRunnableWork } from '../src/runner/runnable.ts';
import { withRuntimeLock } from '../src/migration/runtime-lock.ts';
import { closeControlPlaneDb, openPreparedControlPlaneDb, prepareControlPlaneDb } from '../src/control-plane/db.ts';
const [repo, rawNumber] = process.argv.slice(2);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(rawNumber ?? '')) {
  throw new Error('Usage: npm run run-pr -- owner/repo number');
}
const loaded = loadConfig();
// Schema migration is an exclusive operation and must finish before this worker
// takes the shared runtime lock. The worker then opens the prepared DB read-path.
await prepareControlPlaneDb(loaded.runtimeHome);
await withRuntimeLock(loaded.runtimeHome, 'shared', false, async () => {
  const config = { ...loaded, root: loaded.runtimeHome };
  while (await hasRunnableWork(config.root, repo, Number(rawNumber))) {
    const controlPlaneDb = await openPreparedControlPlaneDb(config.root);
    try {
      const result = await runPullRequest({ ...config, controlPlaneDb }, repo, Number(rawNumber));
      console.log(JSON.stringify(result));
      process.exitCode = ['review_completed', 'already_completed', 'conversation_completed', 'conflict_completed', 'custom_completed', 'ci_completed', 'repair_completed', 'already_running', 'mention_required', 'closed'].includes(result.status) ? 0 : 1;
      if (['already_running', 'publication_interrupted', 'mention_required', 'close_incomplete', 'close_start_unpublished'].includes(result.status)) break;
    } finally {
      closeControlPlaneDb(controlPlaneDb);
    }
  }
});
