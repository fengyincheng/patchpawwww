import { createHash } from 'node:crypto';
import { escapeGitLabQuickActions, GitLabClient } from './client.ts';
import { normalizeGitLabPath, storageKey } from '../identity.ts';
import type { ActorAuthorization, ChangeRequestSnapshot, InboundScmComment, ScmAdapter, ScmCiState, ScmConnection, ScmDeliveryReceipt } from '../types.ts';
import type { ReviewResult } from '../../tasks/review/result.ts';

const access = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 } as const;
function mappedAccess(value: unknown) { return typeof value === 'number' ? value : typeof value === 'string' ? access[value.toLowerCase() as keyof typeof access] ?? null : null; }
function projectRef(connection: ScmConnection, project: any) {
  const projectId = String(project.id);
  const path = normalizeGitLabPath(String(project.path_with_namespace));
  return { connectionId: connection.id, kind: 'gitlab' as const, remoteProjectId: projectId,
    pathWithNamespace: path, webUrl: String(project.web_url), cloneUrl: String(project.http_url_to_repo ?? project.git_http_url ?? project.web_url),
    storageKey: storageKey('gitlab', connection.id, projectId) };
}
function noteMarker(body: string, marker: string) { return body.includes(marker); }

export class GitLabAdapter implements ScmAdapter {
  readonly kind = 'gitlab' as const;
  readonly botLogin: string;
  readonly botUserId?: string;
  constructor(readonly connection: ScmConnection, readonly client: GitLabClient, bot?: { id?: string; username?: string }) {
    this.botLogin = bot?.username ?? connection.botLogin ?? 'patchpaw';
    this.botUserId = bot?.id ?? connection.botUserId ?? undefined;
  }

  async readChangeRequest(projectId: string, number: number, options: { allowClosed?: boolean } = {}): Promise<ChangeRequestSnapshot> {
    const [{ data: project }, { data: mr }] = await Promise.all([this.client.project(projectId), this.client.mergeRequest(projectId, number)]);
    if (!options.allowClosed && mr.state !== 'opened') throw new Error('MR is not open');
    const repository = projectRef(this.connection, project);
    this.client.assertRemoteUrl(repository.cloneUrl);
    const sourceProject = String(mr.source_project_id ?? project.id);
    const targetProject = String(mr.target_project_id ?? project.id);
    const [sourceProjectData, targetBranch] = await Promise.all([
      sourceProject === String(project.id) ? Promise.resolve(project) : this.client.project(sourceProject).then(result => result.data),
      this.client.branch(targetProject, String(mr.target_branch)),
    ]);
    const sourceCloneUrl = this.client.assertRemoteUrl(String(sourceProjectData.http_url_to_repo ?? sourceProjectData.git_http_url ?? sourceProjectData.web_url ?? repository.cloneUrl));
    const sourcePath = normalizeGitLabPath(String(mr.source?.path_with_namespace ?? sourceProjectData.path_with_namespace ?? project.path_with_namespace));
    const targetSha = String(targetBranch.data.commit?.id ?? targetBranch.data.commit?.sha ?? '');
    if (!targetSha) throw new Error('GitLab target branch has no commit tip');
    return { schemaVersion: 1, kind: 'gitlab', repository,
      changeRequest: { repository, number: Number(mr.iid), webUrl: String(mr.web_url) },
      source: { projectId: sourceProject, pathWithNamespace: sourcePath, ref: String(mr.source_branch), sha: String(mr.sha), cloneUrl: sourceCloneUrl },
      target: { projectId: targetProject, pathWithNamespace: normalizeGitLabPath(String(mr.target?.path_with_namespace ?? project.path_with_namespace)), ref: String(mr.target_branch), sha: targetSha },
      diffBaseSha: mr.diff_refs?.base_sha ? String(mr.diff_refs.base_sha) : null, state: String(mr.state), title: String(mr.title ?? ''), body: String(mr.description ?? ''),
      author: { id: mr.author?.id === undefined ? null : String(mr.author.id), login: String(mr.author?.username ?? mr.author?.name ?? '') }, receivedAt: new Date().toISOString() };
  }

  async verifyInboundComment(comment: InboundScmComment): Promise<ActorAuthorization> {
    if (comment.connectionId !== this.connection.id || (!this.connection.projectIds.includes(String(comment.projectId)) && !this.connection.projectIds.includes(comment.repositoryPath))) {
      throw Object.assign(new Error('GitLab project is not registered on this connection'), { status: 403 });
    }
    const [{ data: note }, authorization] = await Promise.all([this.client.note(comment.projectId, comment.changeRequestNumber, comment.remoteId), this.client.members(comment.projectId, comment.authorId)]);
    if (String(note.id) !== String(comment.remoteId) || String(note.author?.id ?? '') !== comment.authorId || String(note.body ?? '') !== comment.body) throw Object.assign(new Error('GitLab note identity mismatch'), { status: 403 });
    const level = mappedAccess(authorization.data?.access_level ?? authorization.data?.accessLevel);
    const can = level !== null && level >= 30 && authorization.data?.state !== 'blocked';
    return { platform: 'gitlab', actorId: comment.authorId, checkedAt: new Date().toISOString(), accessLevel: level, source: 'project_members_all', canExecute: can, canApprove: can };
  }

  async listComments(projectId: string, number: number) {
    return (await this.client.notes(projectId, number)).filter(note => !note.system && !note.position).map(note => ({ id: Number(note.id), author: String(note.author?.username ?? note.author?.name ?? ''), authorId: String(note.author?.id ?? ''), body: String(note.body ?? ''), url: String(note.web_url ?? ''), createdAt: note.created_at ? String(note.created_at) : undefined, system: Boolean(note.system) }));
  }

  async publishComment(projectId: string, number: number, body: string, markers: string[]): Promise<ScmDeliveryReceipt> {
    const safeBody = escapeGitLabQuickActions(body);
    if (markers.length) {
      const botId = this.botUserId ?? String((await this.client.user()).data.id ?? '');
      const existing = (await this.listComments(projectId, number)).find(note => note.authorId === botId && markers.some(marker => noteMarker(note.body, marker)));
      if (existing) return { id: existing.id, htmlUrl: existing.url, publishedAt: existing.createdAt ?? new Date().toISOString(), reused: true, remoteAdopted: true };
    }
    const { data } = await this.client.createNote(projectId, number, safeBody);
    return { id: Number(data.id), htmlUrl: String(data.web_url ?? data.url ?? ''), publishedAt: String(data.created_at ?? new Date().toISOString()), reused: false };
  }

  async publishReview(projectId: string, number: number, headSha: string, review: ReviewResult, mentions: string[], marker: string) {
    const body = `## PatchPaw review\n\n${mentions.map(value => `@${value}`).join(' ')}\n\nHead: \`${headSha}\`\n\n${review.summary}\n\nRecommendation: **${review.recommendation}**\n\n${review.findings.map(f => `- ${f.severity}: ${f.path}:${f.line} — ${f.title}\n  ${f.evidence}`).join('\n')}\n\nLimitations: ${review.limitations.join('; ') || 'None'}\n\n${marker}`;
    const current = await this.readChangeRequest(projectId, number);
    if (current.source.sha !== headSha) throw new Error('MR head changed before review publication');
    return this.publishComment(projectId, number, body, [marker]);
  }

  async readCI(projectId: string, number: number, sha: string): Promise<ScmCiState> {
    const pipelines = (await this.client.mergeRequestPipelines(projectId, number)).filter(pipeline => String(pipeline.sha) === sha);
    const items = [] as ScmCiState['items'];
    for (const pipeline of pipelines) {
      const jobs = await this.client.jobs(projectId, pipeline.id);
      for (const job of jobs) items.push({ name: String(job.name), status: String(job.status), conclusion: job.status === 'success' ? 'success' : job.status === 'failed' ? 'failed' : null, url: job.web_url ? String(job.web_url) : undefined, pipelineId: String(pipeline.id), jobId: String(job.id), sha, allowFailure: Boolean(job.allow_failure) });
    }
    if (!pipelines.length) return { sha, state: 'unknown', items, evidence: [] };
    const pending = items.some(item => ['created', 'pending', 'running', 'manual', 'scheduled', 'waiting', 'preparing', 'waiting_for_resource', 'blocked'].includes(item.status));
    const red = items.some(item => item.conclusion === 'failed' && !item.allowFailure);
    const unknown = items.some(item => ['canceled', 'cancelled', 'skipped', 'unknown'].includes(item.status));
    const state = pending ? 'pending' : red ? 'red' : unknown || !items.length ? 'unknown' : 'green';
    return { sha, state, items, evidence: pipelines.map(pipeline => ({ projectId, pipelineId: String(pipeline.id), source: String(pipeline.source ?? ''), targetSha: String(pipeline.sha) })) };
  }

  async failureEvidence(projectId: string, ci: ScmCiState) {
    const jobs = [];
    for (const item of ci.items.filter(value => value.conclusion === 'failed' && value.jobId)) {
      try { const trace = await this.client.trace(projectId, item.jobId!); jobs.push({ ...item, log: trace.data.slice(0, 200_000) }); }
      catch (error) { jobs.push({ ...item, log: '', logErrorStatus: (error as { status?: number }).status ?? null }); }
    }
    return { sha: ci.sha, items: ci.items, evidence: ci.evidence, jobs };
  }

  async installationGitToken() { return this.client.token; }
}

export async function createGitLabAdapter(connection: ScmConnection, client: GitLabClient) {
  const { data: user } = await client.user();
  return new GitLabAdapter(connection, client, { id: user.id === undefined ? undefined : String(user.id), username: user.username });
}
