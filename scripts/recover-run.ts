import { loadConfig } from '../src/config/env.ts';
import { recoverRun } from '../src/runner/recovery.ts';

const [repo, rawNumber, runId] = process.argv.slice(2);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(rawNumber ?? '') || !/^[\w-]+$/.test(runId ?? '')) {
  throw new Error('Usage: npm run recover-run -- owner/repo pr-number run-id');
}
try {
  const loaded = loadConfig();
  const result = await recoverRun({ ...loaded, root: loaded.runtimeHome }, repo, Number(rawNumber), runId);
  console.log(JSON.stringify(result));
  process.exitCode = ['review_completed', 'already_completed', 'closeout_published'].includes(String(result.status)) ? 0 : 1;
} catch (error) {
  // Do not serialize SDK errors: they can contain request credentials.
  console.error(JSON.stringify({ status: 'recovery_failed', error_name: (error as Error).name,
    http_status: (error as { status?: number }).status ?? null }));
  process.exitCode = 1;
}
