import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadCommandSnapshot } from '../control-plane/index.ts';
import { Trace } from '../harness/trace.ts';
import { disposeWorkspacePath, isManagedWorktree } from '../workspace/repo-store.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readConflictApproval, updateConflictApproval } from './conflict-approval.ts';
import { readConflictProposal, readCurrentConflictProposal, reconcileConflictProposalPublication } from './conflict-proposals.ts';
import { applyRunPhase } from './phases.ts';
import { readPaused, savePaused } from './resume.ts';
import { readState, statePath, writeState } from './state.ts';
import { parseStoredConflictWorkspaceEvidence, workspaceEvidenceSha256 } from './workspace-evidence.ts';
import type { FinalizationConfig, FinalizationContext } from './communication-finalization.ts';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function json(path: string): Promise<JsonObject | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isJsonObject(value)) throw new Error(`Expected JSON object at ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function runDir(root: string, runId: string) { return join(patchpawPaths(root).runs, runId); }
function stringValue(value: unknown) { return typeof value === 'string' ? value : undefined; }

function payloadBody(item: FinalizationContext['stored']['item']) {
  return 'body' in item.payload ? item.payload.body : undefined;
}

async function validateConflictRepairFinalization(config: FinalizationConfig, path: string, repo: string, number: number,
  item: FinalizationContext['stored']['item'], approval: Awaited<ReturnType<typeof readConflictApproval>>, sourceRun: string,
  requireWorkspace: boolean, expectedWorkspacePath?: string) {
  if (!approval) throw new Error('Conflict repair approval is missing');
  const proposal = await readConflictProposal(path, approval.proposal_revision);
  if (!proposal || proposal.proposal_id !== approval.proposal_id || proposal.proposal_hash !== approval.proposal_hash
      || proposal.basis.pr_head_sha !== approval.pr_head_sha || proposal.basis.pr_head_ref !== approval.pr_head_ref
      || proposal.basis.pr_head_repo !== approval.pr_head_repo || proposal.basis.base_ref !== approval.base_ref
      || proposal.basis.current_base_tip_sha !== approval.current_base_tip_sha
      || proposal.basis.command_snapshot_id !== approval.command_snapshot_id
      || proposal.basis.command_snapshot_sha256 !== approval.command_snapshot_sha256) {
    throw new Error('Conflict repair proposal binding is invalid');
  }
  const snapshot = await loadCommandSnapshot(config.root, proposal.repair_run_id, { allowLegacy: true });
  if (snapshot.snapshot.snapshot_id !== approval.command_snapshot_id || snapshot.snapshotSha256 !== approval.command_snapshot_sha256
      || snapshot.snapshot.execution_id !== approval.repair_execution_id || snapshot.snapshot.template_type !== 'conflict'
      || snapshot.snapshot.target !== 'command' || snapshot.snapshot.command?.permission !== 'read_write'
      || snapshot.snapshot.command?.enabled !== true) {
    throw new Error('Conflict repair command snapshot is invalid');
  }
  const original = parseStoredConflictWorkspaceEvidence(await json(join(patchpawPaths(config.root).runs, proposal.repair_run_id, 'workspace-evidence.json')));
  const originalHash = original?.evidence_sha256;
  if (!original || !originalHash) throw new Error('Conflict repair original workspace evidence is invalid');
  const { evidence_sha256: _originalHash, ...originalEvidence } = original;
  if (originalHash !== workspaceEvidenceSha256(originalEvidence)
      || originalHash !== proposal.basis.workspace_evidence_sha256
      || originalEvidence.repository !== repo || originalEvidence.pr_number !== number
      || originalEvidence.pr_head_sha !== approval.pr_head_sha || originalEvidence.initial_head !== approval.pr_head_sha
      || originalEvidence.current_base_tip_sha !== approval.current_base_tip_sha || originalEvidence.base_ref !== approval.base_ref
      || originalEvidence.command_snapshot_id !== approval.command_snapshot_id
      || originalEvidence.command_snapshot_sha256 !== approval.command_snapshot_sha256) {
    throw new Error('Conflict repair original workspace evidence is invalid');
  }
  const commitRun = approval.repair_run_id ?? sourceRun;
  const commit = parseStoredConflictWorkspaceEvidence(await json(join(patchpawPaths(config.root).runs, commitRun, 'conflict-repair-commit-evidence.json')));
  const finalHead = approval.commit_sha ?? stringValue(item.source.commit_sha) ?? '';
  const commitHash = commit?.evidence_sha256;
  const commitEvidence = commit ? (({ evidence_sha256: _commitHash, ...rest }) => rest)(commit) : null;
  if (!finalHead || approval.remote_head_sha !== finalHead || item.source.commit_sha !== undefined && String(item.source.commit_sha) !== finalHead
      || !commit || !commitHash || !commitEvidence || commitHash !== workspaceEvidenceSha256(commitEvidence)
      || commitEvidence.workspace_head !== finalHead || commitEvidence.repository !== repo || commitEvidence.pr_number !== number
      || commitEvidence.pr_head_sha !== approval.pr_head_sha || commitEvidence.initial_head !== approval.pr_head_sha
      || commitEvidence.historical_base_sha !== originalEvidence.historical_base_sha
      || commitEvidence.current_base_tip_sha !== approval.current_base_tip_sha || commitEvidence.base_ref !== approval.base_ref
      || commitEvidence.command_snapshot_id !== approval.command_snapshot_id || commitEvidence.command_snapshot_sha256 !== approval.command_snapshot_sha256) {
    throw new Error('Conflict repair commit evidence is invalid');
  }
  const paused = await readPaused(path);
  if (requireWorkspace) {
    const workspaceOwnerMatches = paused?.run_id === sourceRun || paused?.run_id === proposal.repair_run_id;
    // A recovery may have a newer claim worker while the durable outbox still belongs to the
    // original repair run. Either binding is valid only alongside the exact proposal workspace
    // path and evidence facts checked below.
    const approvalOwnerMatches = approval.claim_run_id === sourceRun || approval.repair_run_id === sourceRun;
    if (!paused?.workspace.path || expectedWorkspacePath && paused.workspace.path !== expectedWorkspacePath
        || !approvalOwnerMatches || !workspaceOwnerMatches || paused.task !== 'conflict'
        || paused.base_ref !== approval.base_ref || paused.workspace.initialHead !== approval.pr_head_sha
        || paused.workspace.mainSha !== approval.current_base_tip_sha || basename(paused.workspace.path) !== proposal.repair_run_id) {
      throw new Error('Conflict repair retained workspace is missing or misbound');
    }
  }
  if (paused?.workspace.path) {
    const exists = await stat(paused.workspace.path).then(() => true, () => false);
    if (exists && !await isManagedWorktree(config.root, repo, paused.workspace.path, undefined, new Trace(runDir(config.root, sourceRun)))) {
      throw new Error('Conflict repair retained workspace is not managed by PatchPaw');
    }
  }
  return { proposal, paused, finalHead };
}

export async function finalizeLegacyConflictProposal(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  await reconcileConflictProposalPublication(config.root, path, item.repo, item.pr_number, false);
  return done();
}

export async function finalizeLegacyConflictRepair(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  const sourceRun = typeof item.source.run_id === 'string' ? item.source.run_id : undefined;
  const approvalId = typeof item.source.approval_id === 'string' ? item.source.approval_id : undefined;
  if (!sourceRun || !approvalId) return done();
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  const approval = await readConflictApproval(path, approvalId);
  const state = await readState(path);
  if (!approval || approval.status !== 'accepted') return done();
  if (approval.phase === 'completed') {
    const validated = await validateConflictRepairFinalization(config, path, item.repo, item.pr_number, item, approval, sourceRun, false);
    if (validated.paused?.run_id === sourceRun && validated.paused.task === 'conflict'
        && basename(validated.paused.workspace.path) === validated.proposal.repair_run_id && validated.paused.workspace.path) {
      await disposeWorkspacePath(config.root, item.repo, validated.paused.workspace.path, new Trace(runDir(config.root, sourceRun)));
    }
    return done();
  }
  if (!['remote_confirmed', 'publication_pending'].includes(approval.phase)) return done();
  if (!state || state.run_id !== sourceRun) {
    const validated = await validateConflictRepairFinalization(config, path, item.repo, item.pr_number, item, approval, sourceRun, false);
    if (validated.paused?.run_id === sourceRun && validated.paused.task === 'conflict'
        && basename(validated.paused.workspace.path) === validated.proposal.repair_run_id && validated.paused.workspace.path) {
      await disposeWorkspacePath(config.root, item.repo, validated.paused.workspace.path, new Trace(runDir(config.root, sourceRun)));
    }
    if (state && state.run_id !== sourceRun && state.run_id === approval.claim_run_id && state.phase !== 'closed' && !state.closed_at) {
      const recoveryDir = runDir(config.root, state.run_id);
      const recoveryDelivery = await json(join(recoveryDir, 'delivery.json'));
      const recoveryResult = await json(join(recoveryDir, 'result.json'));
      const answer = stringValue(recoveryDelivery?.body) ?? payloadBody(item);
      const publication = { ...(item.receipt ?? {}), delivery_id: item.delivery_id, recovered: true };
      const result = { ...(recoveryResult ?? {}), status: 'repair_completed', run_id: state.run_id,
        repo: item.repo, pr_number: item.pr_number, final_head_sha: validated.finalHead, recovered: true,
        ...(answer ? { answer } : {}), publication };
      const trace = new Trace(recoveryDir);
      trace.save('result.json', result);
      trace.emit('conflict_repair_recovery_state_finalized', { delivery_id: item.delivery_id, run_id: state.run_id, approval_id: approvalId });
      await writeState(path, applyRunPhase({ ...state, active: false, current_head_sha: validated.finalHead }, 'repair_completed'));
    }
    await updateConflictApproval(path, approvalId, { phase: 'completed', final_publication_delivery_id: item.delivery_id,
      final_publication_remote_id: item.receipt?.id, final_published_at: item.receipt?.published_at ?? new Date().toISOString() });
    return done();
  }
  const dir = runDir(config.root, sourceRun);
  const current = await readCurrentConflictProposal(path);
  if (!current || current.proposal.status !== 'published' || current.proposal.proposal_id !== approval.proposal_id
      || current.proposal.proposal_revision !== approval.proposal_revision || current.proposal.proposal_hash !== approval.proposal_hash) {
    throw new Error('Conflict repair current proposal is missing or stale');
  }
  const validated = await validateConflictRepairFinalization(config, path, item.repo, item.pr_number, item, approval, sourceRun, true, current.pointer.workspace_path);
  const delivery = await json(join(dir, 'delivery.json'));
  const publication = await json(join(dir, 'conflict-repair-publication.json')) ?? { ...item.receipt, delivery_id: item.delivery_id };
  const finalHead = validated.finalHead || state.current_head_sha;
  if (!finalHead) throw new Error('Conflict repair final head is missing');
  const existing = await json(join(dir, 'result.json'));
  const answer = stringValue(delivery?.body) ?? payloadBody(item);
  const result = { ...(existing ?? {}), status: 'repair_completed', run_id: sourceRun, repo: item.repo,
    pr_number: item.pr_number, final_head_sha: finalHead, recovered: true, ...(answer ? { answer } : {}), publication };
  await writeState(path, applyRunPhase({ ...state, active: false, current_head_sha: finalHead }, 'repair_completed'));
  const paused = validated.paused;
  if (paused?.workspace.path) await savePaused(path, { ...paused, status: 'completed' });
  const trace = new Trace(dir);
  trace.save('result.json', result);
  trace.emit('conflict_repair_delayed_delivery_finalized', { delivery_id: item.delivery_id, run_id: sourceRun, approval_id: approvalId });
  if (paused?.workspace.path) await disposeWorkspacePath(config.root, item.repo, paused.workspace.path, trace);
  await updateConflictApproval(path, approvalId, { phase: 'completed', final_publication_delivery_id: item.delivery_id,
    final_publication_remote_id: item.receipt?.id, final_published_at: item.receipt?.published_at ?? new Date().toISOString() });
  return done();
}
