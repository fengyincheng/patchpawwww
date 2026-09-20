import { git } from '../../workspace/git.ts';
import type { WorkspaceState } from '../../workspace/manager.ts';
import type { ChangeRequestSnapshot } from '../../scm/types.ts';
import type { Trace } from '../trace.ts';
import { excerpt } from './policy.ts';
import type { CurrentBaseSnapshot } from '../runtime.ts';

export async function seedContext(pr: ChangeRequestSnapshot, ws: WorkspaceState, trace: Trace, currentBase?: CurrentBaseSnapshot) {
  const currentBaseTipSha = currentBase?.sha ?? ws.mainSha;
  const currentBaseRef = currentBase?.ref ?? pr.target.ref;
  const changed = await git(ws.path, ['diff', '--name-only', `${currentBaseTipSha}...HEAD`], trace);
  const stat = await git(ws.path, ['diff', '--stat', `${currentBaseTipSha}...HEAD`], trace);
  const status = await git(ws.path, ['status', '--short'], trace);
  const headSha = (await git(ws.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
  return { repository: pr.repository.pathWithNamespace, pr_number: pr.changeRequest.number, title: pr.title,
    body: excerpt(pr.body), base_sha: pr.diffBaseSha ?? pr.target.sha, head_sha: headSha,
    // Legacy current_main_sha is the workspace provenance and may be older for a retained
    // Conversation workspace. The explicit fields below identify this run's fetched evidence.
    current_main_sha: ws.mainSha, current_base_ref: currentBaseRef, current_base_tip_sha: currentBaseTipSha,
    workspace_base_tip_sha: ws.mainSha, pr_diff_basis: `merge-base(${currentBaseTipSha}, ${headSha}) -> ${headSha}`,
    changed_files: excerpt(changed.stdout), diff_stat: excerpt(stat.stdout),
    workspace: ws.path, git_status: excerpt(status.stdout), unmerged_files: ws.unmerged, merge_pending: ws.mergePending };
}
