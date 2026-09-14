import type { Octokit } from '@octokit/rest';
import { setTimeout } from 'node:timers/promises';
import type { Trace } from '../harness/trace.ts';
import { budget } from '../harness/budget.ts';

export async function readCI(client: Octokit, fullName: string, sha: string) {
  const [owner, repo] = fullName.split('/');
  const [checks, status, workflows] = await Promise.all([
    client.paginate(client.rest.checks.listForRef, { owner, repo, ref: sha, filter: 'latest', per_page: 100 }),
    client.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 }),
    client.paginate(client.rest.actions.listWorkflowRunsForRepo, { owner, repo, head_sha: sha, per_page: 100 }),
  ]);
  const latestWorkflows = [...new Map(workflows.sort((a, b) => a.id - b.id).map(run => [run.workflow_id, run] as const)).values()];
  const items = [
    ...checks.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, kind: 'check', output: c.output })),
    ...status.data.statuses.map(s => ({ name: s.context, status: s.state === 'pending' ? 'pending' : 'completed',
      conclusion: s.state, url: s.target_url, kind: 'status' })),
    ...latestWorkflows.map(w => ({ name: w.name, status: w.status, conclusion: w.conclusion, url: w.html_url, kind: 'workflow' })),
  ];
  const pending = items.some(i => i.status !== 'completed');
  const red = items.some(i => i.status === 'completed' && !['success', 'neutral', 'skipped'].includes(i.conclusion ?? ''));
  return { sha, state: !items.length || pending ? 'pending' : red ? 'red' : 'green', items,
    workflowRuns: latestWorkflows.map(w => ({ id: w.id, name: w.name, status: w.status, conclusion: w.conclusion, event: w.event, head_sha: w.head_sha })) };
}
export type CIState = Awaited<ReturnType<typeof readCI>>;

export async function waitForCI(client: Octokit, fullName: string, sha: string, trace: Trace, signal?: AbortSignal) {
  const started = Date.now();
  let last: CIState;
  let terminalSignature = '';
  do {
    signal?.throwIfAborted();
    last = await readCI(client, fullName, sha);
    trace.emit('ci_poll', last);
    const signature = JSON.stringify(last);
    // Allow new head's workflows/checks to register before accepting a terminal result.
    if (last.state !== 'pending' && signature === terminalSignature) return last;
    terminalSignature = last.state === 'pending' ? '' : signature;
    await setTimeout(budget.ciPollMs, undefined, { signal });
  } while (Date.now() - started < budget.ciWaitMs);
  return last;
}

export async function failureEvidence(client: Octokit, fullName: string, ci: CIState, trace: Trace) {
  const [owner, repo] = fullName.split('/');
  const jobs = [];
  for (const run of ci.workflowRuns.filter(r => r.conclusion && !['success', 'skipped', 'neutral'].includes(r.conclusion))) {
    const all = await client.paginate(client.rest.actions.listJobsForWorkflowRun, { owner, repo, run_id: run.id, filter: 'latest', per_page: 100 });
    for (const job of all.filter(j => j.conclusion !== 'success' && j.conclusion !== 'skipped')) {
      let log = '', logError: number | null = null;
      try {
        const response = await client.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: job.id });
        const raw = response.data as unknown;
        log = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : JSON.stringify(raw);
      } catch (error) { logError = (error as { status?: number }).status ?? 0; }
      const evidence = { workflow: run.name, job: job.name, id: job.id, conclusion: job.conclusion,
        steps: job.steps, log, log_error_status: logError };
      jobs.push(evidence);
      trace.emit('ci_failure_evidence', evidence);
    }
  }
  return { sha: ci.sha, items: ci.items, jobs };
}
