import { loadConfig } from '../src/config/env.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { hasRunnableWork } from '../src/runner/runnable.ts';
import { withRuntimeLock } from '../src/migration/runtime-lock.ts';
import { closeControlPlaneDb, openPreparedControlPlaneDb, prepareControlPlaneDb } from '../src/control-plane/db.ts';
import { getRepository } from '../src/control-plane/repositories.ts';
const [firstArg, secondArg, thirdArg] = process.argv.slice(2);
const explicitRepositoryId = firstArg === '--repository-id' ? secondArg : undefined;
const rawNumber = firstArg === '--repository-id' ? thirdArg : secondArg;
if ((!explicitRepositoryId && !firstArg) || !/^[1-9]\d*$/.test(rawNumber ?? '')
  || (!explicitRepositoryId && !(/^[\w.-]+\/[\w.-]+$/.test(firstArg) || /^gitlab:[A-Za-z0-9][A-Za-z0-9_.:-]*:project:[^/]+$/.test(firstArg)))) {
  throw new Error('Usage: npm run run-pr -- owner/repo number | gitlab:connection:project:id number | --repository-id UUID number');
}
const loaded = loadConfig();
// Schema migration is an exclusive operation and must finish before this worker
// takes the shared runtime lock. The worker then opens the prepared DB read-path.
await prepareControlPlaneDb(loaded.runtimeHome);
await withRuntimeLock(loaded.runtimeHome, 'shared', false, async () => {
  const config = { ...loaded, root: loaded.runtimeHome };
  let repo = firstArg ?? '';
  if (explicitRepositoryId) {
    const controlPlaneDb = await openPreparedControlPlaneDb(config.root);
    try {
      const repository = await getRepository(controlPlaneDb, explicitRepositoryId);
      if (!repository) throw new Error(`Repository UUID was not found: ${explicitRepositoryId}`);
      repo = repository.storageKey;
    } finally { closeControlPlaneDb(controlPlaneDb); }
  }
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
