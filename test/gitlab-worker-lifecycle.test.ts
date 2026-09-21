import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/workspace/git.ts';
import { ensureRepo, repoCachePath } from '../src/workspace/repo-store.ts';
import { Trace } from '../src/harness/trace.ts';
import { runGitLabMergeRequest } from '../src/scm/gitlab/runner.ts';
import { GitLabAdapter } from '../src/scm/gitlab/adapter.ts';
import { GitLabClient } from '../src/scm/gitlab/client.ts';
import type { ScmConnection } from '../src/scm/types.ts';
import { hasHumanReplies, saveHumanReply, readHumanReplies } from '../src/runner/human-feedback.ts';
import { statePath, readState } from '../src/runner/state.ts';
import { readCurrentApprovalPlan } from '../src/runner/approval-plans.ts';
import { patchpawPaths } from '../src/config/paths.ts';
import { bootstrapControlPlane, closeControlPlaneDb, createCommand, createPrompt, listPrompts, listSkills, openControlPlaneDb, setProviderCredential } from '../src/control-plane/index.ts';
import { deliverImmediately, listOutbound } from '../src/runner/outbound.ts';

const repo = 'gitlab:worker:project:88';

function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return { data, status, headers };
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, result: ReturnType<typeof json>) {
  const body = JSON.stringify(result.data);
  response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...result.headers });
  response.end(body);
}

async function createRemote(root: string, conflict: boolean) {
  const source = join(root, 'source'); const projects = join(root, 'projects'); const bare = join(projects, 'group/repo.git');
  await mkdir(source); await mkdir(join(projects, 'group'), { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Fixture']); await git(source, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(source, 'sample.txt'), 'base\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'base']);
  const base = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(source, ['branch', 'feature']);
  if (conflict) {
    await writeFile(join(source, 'sample.txt'), 'main\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'main change']);
    await git(source, ['switch', 'feature']); await writeFile(join(source, 'sample.txt'), 'feature\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'feature change']);
  }
  await git(source, ['init', '--bare', bare]);
  await git(source, ['remote', 'add', 'fixture', bare]); await git(source, ['push', 'fixture', 'main', 'feature']);
  return { source, projects, bare, base };
}

interface WorkerControl {
  mode: 'review' | 'repair' | 'conflict' | 'custom' | 'stop' | 'active-close';
  customMode: 'agent-commit' | 'harness-commit' | 'agent-commit-dirty' | 'agent-push' | 'rewrite' | 'no-op';
  externalDrift?: 'head' | 'base';
  driftApplied: boolean;
  customStep: number;
  fork: boolean;
  modelCalls: number;
  normalModelCalls: number;
  repairStep: number;
  holdNormalModel: boolean;
  modelFailure?: 'provider_429' | 'provider_401' | 'provider_403' | 'invalid_response';
  userFailure?: { status: number } | 'network';
  botIdentity?: { id?: number; username?: string };
  modelStarted?: () => void;
  releaseNormalModel?: () => void;
  mrState: 'opened' | 'closed' | 'merged';
  nextNoteId: number;
  remoteNotes: any[];
  failNotePublication: boolean;
  apiCalls: Array<{ method: string; path: string }>;
  mrReads: Array<{ sha: string; targetSha: string }>;
}

interface WorkerFixture {
  root: string;
  remote: Awaited<ReturnType<typeof createRemote>>;
  cloneUrl: string;
  control: WorkerControl;
  path: string;
  repositoryId: string;
  modelId: string;
  config: { root: string; snapshotRoot: string; operatorLogin: string; gitlabConnections: Array<{ id: string; instanceUrl: string; projectIds: string[]; token: string; botUserId: string; botLogin: string }> };
  modelReady: Promise<void>;
  addComment: (id: number, body: string, authorId?: string) => Promise<void>;
}

async function workerFixture(t: TestContext, mode: WorkerControl['mode'], conflict = false): Promise<WorkerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-gitlab-worker-'));
  const remote = await createRemote(root, conflict);
  let instanceUrl = '';
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP address');
  instanceUrl = `http://127.0.0.1:${address.port}/gitlab`;
  const cloneUrl = `${instanceUrl}/group/repo.git`;
  const path = statePath(patchpawPaths(root).state, repo, 3);
  const control: WorkerControl = { mode, customMode: 'harness-commit', customStep: 0, fork: false, driftApplied: false, modelCalls: 0, normalModelCalls: 0, repairStep: 0, holdNormalModel: false,
    mrState: 'opened', nextNoteId: 700, remoteNotes: [], failNotePublication: false, apiCalls: [], mrReads: [] };
  const config = { root, snapshotRoot: join(root, 'snapshots'), operatorLogin: 'operator', gitlabConnections: [{ id: 'worker', instanceUrl,
    projectIds: ['88'], token: 'fixture-token', botUserId: '900', botLogin: 'patchpaw' }] };
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const modelUrl = `${instanceUrl.slice(0, -'/gitlab'.length)}/v1`;
  const bootstrap = await bootstrapControlPlane({ root, env: { ...process.env, ZAI_BASE_URL: modelUrl, ZAI_MODEL: 'fixture-model' }, repositories: [{
    fullName: 'group/repo', displayName: 'group/repo', scmKind: 'gitlab', connectionId: 'worker', remoteProjectId: '88', pathWithNamespace: 'group/repo',
    webUrl: `${instanceUrl}/group/repo`, cloneUrl, storageKey: repo,
  }] });
  const controlPlane = await openControlPlaneDb(root);
  const repository = bootstrap.repositories[0]!;
  try {
    await setProviderCredential(controlPlane, root, bootstrap.provider.id, 'fixture-secret');
    const prompts = await listPrompts(controlPlane, { scope: 'repository', repositoryId: repository.id });
    const skills = await listSkills(controlPlane, { scope: 'repository', repositoryId: repository.id });
    const prompt = (role: string) => prompts.find(value => value.role === role)!;
    await createCommand(controlPlane, { repositoryId: repository.id, slashName: '/repair', displayName: '/repair', executionType: 'repair', permission: 'read_write',
      providerModelId: bootstrap.model.id, promptBindings: [
        { assetId: prompt('repair-completion').id, position: 1, enabled: true, bindingKind: 'main' },
        { assetId: prompt('shared').id, position: 2, enabled: true, bindingKind: 'common' },
        { assetId: prompt('repair-feedback').id, position: 3, enabled: true, bindingKind: 'auxiliary' },
        { assetId: prompt('repair-no-verification').id, position: 4, enabled: true, bindingKind: 'auxiliary' },
        { assetId: prompt('repair-verification-empty').id, position: 5, enabled: true, bindingKind: 'auxiliary' },
        { assetId: prompt('repair-closeout').id, position: 6, enabled: true, bindingKind: 'auxiliary' },
        { assetId: prompt('stop-closeout').id, position: 7, enabled: true, bindingKind: 'auxiliary' },
      ], skillBindings: [{ assetId: skills.find(value => value.slug === 'patchpaw-human-help')!.id, position: 1, enabled: true }] });
  } finally { closeControlPlaneDb(controlPlane); }
  const seedTrace = new Trace(join(root, 'seed-trace'));
  await ensureRepo(root, repo, cloneUrl, seedTrace);
  await git(repoCachePath(root, repo), ['config', `url.${remote.bare}.insteadOf`, cloneUrl], seedTrace);
  const modelReady = new Promise<void>(resolve => { control.modelStarted = resolve; });
  const modelReleased = new Promise<void>(resolve => { control.releaseNormalModel = resolve; });
  const advanceRemoteBranch = async (branch: 'feature' | 'main') => {
    await git(remote.source, ['switch', branch]);
    await writeFile(join(remote.source, 'drift.txt'), `${branch} drift\n`);
    await git(remote.source, ['add', 'drift.txt']); await git(remote.source, ['commit', '-m', `External ${branch} drift`]);
    await git(remote.source, ['push', 'fixture', branch]);
  };
  const responseForModel = async (body: any) => {
    control.modelCalls++;
    if (control.modelFailure === 'provider_429') return json({ error: { message: 'fixture provider overloaded', code: 1305 } }, 429, { 'retry-after': '0' });
    if (control.modelFailure === 'provider_401') return json({ error: { message: 'fixture provider credentials rejected', code: 'invalid_api_key' } }, 401);
    if (control.modelFailure === 'provider_403') return json({ error: { message: 'fixture provider access denied', code: 'forbidden' } }, 403);
    if (control.modelFailure === 'invalid_response') return json({ choices: [{ message: { role: 'assistant', content: '{invalid' }, finish_reason: 'stop' }] });
    const tools = (body.tools ?? []) as Array<{ function?: { name?: string } }>;
    const toolNames = new Set(tools.map(tool => tool.function?.name));
    const stopCloseout = toolNames.size === 1 && toolNames.has('submit_stop_report');
    if (control.mode === 'custom') {
      const step = control.customStep++;
      if (control.customMode === 'no-op' || step >= (control.customMode === 'agent-commit-dirty' ? 2 : 1)) {
        if (control.externalDrift && !control.driftApplied) {
          control.driftApplied = true;
          await advanceRemoteBranch(control.externalDrift === 'head' ? 'feature' : 'main');
        }
        return json({ id: `custom-${control.modelCalls}`, model: 'fixture', choices: [{ index: 0,
          message: { role: 'assistant', content: 'CUSTOM_NATURAL_LANGUAGE_ANSWER' }, finish_reason: 'stop' }] });
      }
      const tool = control.customMode === 'agent-commit'
        ? { name: 'mastra_workspace_execute_command', args: { command: "printf 'agent\\n' > sample.txt && git add sample.txt && git commit -m 'Agent authored custom fix'" } }
        : control.customMode === 'agent-push'
        ? { name: 'mastra_workspace_execute_command', args: { command: "printf 'agent\\n' > sample.txt && git add sample.txt && git commit -m 'Agent authored custom fix' && git push origin HEAD:refs/heads/feature" } }
        : control.customMode === 'rewrite'
        ? { name: 'mastra_workspace_execute_command', args: { command: "git checkout --orphan rewritten && git rm -rf . && printf 'rewritten\\n' > rewritten.txt && git add rewritten.txt && git commit -m 'Rewritten custom history'" } }
        : control.customMode === 'agent-commit-dirty'
        ? step === 0
          ? { name: 'mastra_workspace_execute_command', args: { command: "printf 'agent\\n' > sample.txt && git add sample.txt && git commit -m 'Agent authored custom fix'" } }
          : { name: 'mastra_workspace_execute_command', args: { command: "printf 'residual\\n' > residual.txt" } }
        : { name: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'base', new_string: 'harness' } };
      return json({ id: `custom-${control.modelCalls}`, model: 'fixture', choices: [{ index: 0,
        message: { role: 'assistant', content: '', tool_calls: [{ id: `custom-call-${control.modelCalls}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] },
        finish_reason: 'tool_calls' }] });
    }
    if (stopCloseout) return json({ id: `stop-${control.modelCalls}`, model: 'fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: '', tool_calls: [{ id: `call-${control.modelCalls}`, type: 'function', function: { name: 'submit_stop_report', arguments: JSON.stringify({ summary: '已收到停止请求，工作区保留。' }) } }] },
      finish_reason: 'tool_calls' }] });
    control.normalModelCalls++;
    control.modelStarted?.();
    if (control.holdNormalModel) await modelReleased;
    let tool: { name: string; args: Record<string, unknown> } | undefined;
    if (control.mode === 'review') {
      return json({ id: `review-${control.modelCalls}`, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
        summary: '当前 head 的 review', recommendation: 'comment', findings: [], limitations: [],
      }) }, finish_reason: 'stop' }] });
    }
    if (control.mode === 'conflict' && toolNames.has('submit_conflict_proposal')) {
      tool = { name: 'submit_conflict_proposal', args: { summary: '需要确认冲突语义。', pr_intent: '保留 feature 行为。', current_base_intent: 'main 有独立修改。',
        conflicts: [{ path: 'sample.txt', issue: '同一行内容不同。', pr_side: 'feature', base_side: 'main', proposed_resolution: '由人确认最终内容。', disagreement_or_tradeoff: '两边语义不能自动合并。' }],
        affected_files: ['sample.txt'], verification_plan: ['test -f sample.txt'], risks_or_open_questions: ['需要人工确认。'], human_markdown_summary: '等待 /approval。' } };
    } else if (control.mode === 'repair' || control.mode === 'conflict' || (control.mode === 'active-close' && control.repairStep > 0)) {
      if (control.repairStep++ === 0) tool = control.mode === 'conflict'
        ? { name: 'mastra_workspace_execute_command', args: { command: "printf 'resolved\\n' > sample.txt && git add sample.txt" } }
        : { name: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'base', new_string: 'fixed' } };
      else return json({ id: `repair-${control.modelCalls}`, model: 'fixture', choices: [{ index: 0,
        message: { role: 'assistant', content: '修复完成：已完成候选修改并确认工作区状态。' }, finish_reason: 'stop' }] });
    } else if (control.mode === 'stop' || control.mode === 'active-close') {
      tool = { name: 'request_human_help', args: { reason: '测试任务等待人工处理。' } };
    } else if (control.mode === 'conflict') {
      tool = { name: 'mastra_workspace_execute_command', args: { command: "printf 'resolved\\n' > sample.txt && git add sample.txt" } };
    }
    if (!tool) throw new Error(`Unexpected fake model request for ${control.mode}: ${[...toolNames].join(',')}`);
    return json({ id: `response-${control.modelCalls}`, model: 'fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: '', tool_calls: [{ id: `call-${control.modelCalls}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] },
      finish_reason: 'tool_calls' }] });
  };
  server.on('request', async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const method = request.method ?? 'GET';
    try {
      const body = await requestBody(request);
      if (url.pathname === '/v1/chat/completions') return sendJson(response, await responseForModel(JSON.parse(body || '{}')));
      control.apiCalls.push({ method, path: url.pathname });
      if (url.pathname === '/gitlab/api/v4/user') {
        if (control.userFailure === 'network') return request.socket.destroy();
        if (control.userFailure) return sendJson(response, json({ message: `fixture user failure ${control.userFailure.status}` }, control.userFailure.status));
        return sendJson(response, json({ id: control.botIdentity?.id ?? 900, username: control.botIdentity?.username ?? 'patchpaw', bot: true, state: 'active' }));
      }
      if (url.pathname === '/gitlab/api/v4/projects/88') return sendJson(response, json({ id: 88, path_with_namespace: 'group/repo', web_url: `${instanceUrl}/group/repo`, http_url_to_repo: cloneUrl }));
      if (url.pathname === '/gitlab/api/v4/projects/99') return sendJson(response, json({ id: 99, path_with_namespace: 'other/repo', web_url: `${instanceUrl}/other/repo`, http_url_to_repo: cloneUrl }));
      if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3') {
        const head = (await git(remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
        const main = (await git(remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim();
        control.mrReads.push({ sha: head, targetSha: main });
        return sendJson(response, json({ iid: 3, state: control.mrState, source_project_id: control.fork ? 99 : 88, target_project_id: 88, source: { path_with_namespace: control.fork ? 'other/repo' : 'group/repo' },
          target: { path_with_namespace: 'group/repo' }, source_branch: 'feature', target_branch: 'main', sha: head,
          diff_refs: { base_sha: remote.base, start_sha: main }, title: 'Fixture MR', description: 'Fixture body', author: { id: 17, username: 'developer' },
          web_url: `${instanceUrl}/group/repo/-/merge_requests/3` }));
      }
      if (url.pathname === '/gitlab/api/v4/projects/88/repository/branches/main') {
        return sendJson(response, json({ name: 'main', commit: { id: (await git(remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim() } }));
      }
      const note = url.pathname.match(/^\/gitlab\/api\/v4\/projects\/88\/merge_requests\/3\/notes\/(\d+)$/);
      if (note) {
        const found = control.remoteNotes.find(value => String(value.id) === note[1]);
        return sendJson(response, found ? json(found) : json({ message: 'not found' }, 404));
      }
      if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3/notes' && method === 'GET') return sendJson(response, json(control.remoteNotes));
      if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3/notes' && method === 'POST') {
        if (control.failNotePublication) return sendJson(response, json({ message: 'fixture publication failure' }, 400));
        const payload = JSON.parse(body || '{}') as { body?: string };
        const created = { id: ++control.nextNoteId, body: payload.body ?? '', author: { id: 900, username: 'patchpaw' }, web_url: `${instanceUrl}/note/${control.nextNoteId}`,
          created_at: new Date().toISOString(), system: false };
        control.remoteNotes.push(created); return sendJson(response, json(created, 201));
      }
      const user = url.pathname.match(/^\/gitlab\/api\/v4\/users\/(\d+)$/);
      if (user?.[1] === '17') return sendJson(response, json({ id: 17, username: 'developer', bot: false, state: 'active' }));
      const member = url.pathname.match(/^\/gitlab\/api\/v4\/projects\/88\/members\/all\/(\d+)$/);
      if (member?.[1] === '17') return sendJson(response, json({ access_level: 30, state: 'active' }));
      throw new Error(`Unexpected GitLab fixture endpoint: ${method} ${url.pathname}`);
    } catch (error) { sendJson(response, json({ message: (error as Error).message }, 500)); }
  });
  return { root, remote, cloneUrl, control, path, repositoryId: repository.id, modelId: bootstrap.model.id, config, modelReady, addComment: async (id: number, body: string, authorId = '17') => {
    const createdAt = new Date(Date.now() + id * 1000).toISOString();
    control.remoteNotes.push({ id, body, author: { id: Number(authorId), username: authorId === '17' ? 'developer' : 'operator' }, web_url: `https://git.example/note/${id}`, created_at: createdAt, system: false });
    await saveHumanReply(path, { repo, pr_number: 3, comment_id: id, author: authorId === '17' ? 'developer' : 'operator', author_id: authorId,
      body, url: `https://git.example/group/repo/-/merge_requests/3#note_${id}`, created_at: createdAt, source_event_id: `fixture-${id}`, platform: 'gitlab', connection_id: 'worker', project_id: '88', repository_path: 'group/repo' });
  } };
}

async function addCustomCommand(fixture: WorkerFixture, permission: 'read_only' | 'read_write' = 'read_write') {
  const db = await openControlPlaneDb(fixture.root);
  try {
    const prompt = await createPrompt(db, { scope: 'repository', repositoryId: fixture.repositoryId, slug: 'custom-edit', title: 'Custom edit', role: null,
      content: 'CUSTOM_EDIT_MARKER\nMake the requested change in the writable workspace, then explain what you did.' });
    return await createCommand(db, { repositoryId: fixture.repositoryId, slashName: '/edit', displayName: 'Edit', executionType: 'custom', permission,
      providerModelId: fixture.modelId, promptBindings: [{ assetId: prompt.id, position: 1, enabled: true, bindingKind: 'main' }], skillBindings: [] });
  } finally { closeControlPlaneDb(db); }
}

test('GitLab worker review publishes a durable review on the current head', async t => {
  const fixture = await workerFixture(t, 'review'); await fixture.addComment(100, '@patchpaw /review');
  const expectedHead = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'review_completed');
  assert.equal((await readState(fixture.path))?.phase, 'review_completed');
  assert.equal(fixture.control.normalModelCalls, 1);
  const review = fixture.control.remoteNotes.find(note => note.author.id === 900 && note.body.includes('## PatchPaw review'));
  assert.ok(review); assert.ok(review.body.includes(expectedHead));
});

test('GitLab worker repair pushes only the same-project source branch before publishing completion', async t => {
  const fixture = await workerFixture(t, 'repair'); await fixture.addComment(100, '@patchpaw /repair');
  const beforeFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const beforeMain = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const afterFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const afterMain = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim();
  assert.equal(result?.status, 'repair_completed'); assert.notEqual(afterFeature, beforeFeature); assert.equal(afterMain, beforeMain);
  assert.equal((await readState(fixture.path))?.phase, 'repair_completed');
  assert.ok(fixture.control.mrReads.some(read => read.sha === beforeFeature));
  assert.ok(fixture.control.mrReads.some(read => read.sha === afterFeature));
  assert.ok(fixture.control.mrReads.filter(read => read.targetSha === beforeMain).length >= 3);
  const lastHeadRead = fixture.control.apiCalls.map((value, index) => value.path.endsWith('/merge_requests/3') ? index : -1).reduce((last, index) => Math.max(last, index), -1);
  const notePublish = fixture.control.apiCalls.map((value, index) => value.method === 'POST' && value.path.endsWith('/merge_requests/3/notes') ? index : -1).reduce((last, index) => Math.max(last, index), -1);
  assert.ok(lastHeadRead >= 0 && notePublish > lastHeadRead);
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes(afterFeature)));
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report')?.item.status, 'delivered');
  assert.ok(fixture.control.apiCalls.filter(value => value.path.endsWith('/merge_requests/3')).length >= 2);
});

test('GitLab custom read_write pushes an Agent commit without a duplicate Harness commit', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'agent-commit'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const after = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(result?.status, 'custom_completed');
  assert.notEqual(after, before);
  assert.equal((await git(fixture.remote.bare, ['rev-list', '--count', `${before}..${after}`])).stdout.trim(), '1');
  assert.equal((await git(fixture.remote.bare, ['log', '-1', '--format=%s', after])).stdout.trim(), 'Agent authored custom fix');
  assert.equal(typeof (result as any).run_id, 'string');
  assert.equal((await readFile(join(fixture.root, 'runs', (result as any).run_id, 'trace.jsonl'), 'utf8')).includes('"source":"agent"'), true);
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('PatchPaw 提交') && note.body.includes(after)));
});

test('GitLab custom read_write lets the Harness commit an uncommitted Agent change', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'harness-commit'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const after = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(result?.status, 'custom_completed');
  assert.notEqual(after, before);
  assert.equal((await git(fixture.remote.bare, ['rev-list', '--count', `${before}..${after}`])).stdout.trim(), '1');
  assert.equal((await git(fixture.remote.bare, ['log', '-1', '--format=%s', after])).stdout.trim(), 'fix: PatchPaw custom repair');
  assert.equal((await readState(fixture.path))?.phase, 'custom_completed');
  assert.equal((await readState(fixture.path))?.current_head_sha, after);
  assert.equal((await readState(fixture.path))?.last_patchpaw_commit, after);
  const delivery = (await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report');
  assert.equal(delivery?.item.status, 'delivered');
  assert.ok(delivery?.item.receipt?.id);
});

test('GitLab custom read_write commits residual dirty changes after an Agent commit', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'agent-commit-dirty'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const after = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(result?.status, 'custom_completed');
  assert.equal((await git(fixture.remote.bare, ['rev-list', '--count', `${before}..${after}`])).stdout.trim(), '2');
  assert.equal((await git(fixture.remote.bare, ['show', `${after}:sample.txt`])).stdout, 'agent\n');
  assert.equal((await git(fixture.remote.bare, ['show', `${after}:residual.txt`])).stdout, 'residual\n');
  assert.equal((await readState(fixture.path))?.current_head_sha, after);
  assert.equal((await readState(fixture.path))?.last_patchpaw_commit, after);
});

test('GitLab custom read_write no-op publishes without committing or pushing', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'no-op'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const after = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(result?.status, 'custom_completed');
  assert.equal(after, before);
  assert.equal((await readState(fixture.path))?.phase, 'custom_completed');
  assert.equal((await readState(fixture.path))?.current_head_sha, before);
  assert.equal((await readState(fixture.path))?.last_patchpaw_commit, null);
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report')?.item.status, 'delivered');
  assert.equal(fixture.control.apiCalls.some(call => call.method === 'POST' && call.path.endsWith('/repository/commits')), false);
});

test('GitLab custom writeback publication recovery retries the durable Note without rerunning the Agent', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.failNotePublication = true; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const after = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(result?.status, 'custom_completed');
  assert.notEqual(after, before);
  assert.equal((await readState(fixture.path))?.phase, 'custom_completed');
  const stored = (await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report');
  assert.ok(stored); assert.equal(stored!.item.status, 'blocked');
  const modelCalls = fixture.control.modelCalls;
  const commits = (await git(fixture.remote.bare, ['rev-list', '--count', `${before}..${after}`])).stdout.trim();
  fixture.control.failNotePublication = false;
  const connection: ScmConnection = { id: 'worker', kind: 'gitlab', instanceUrl: fixture.config.gitlabConnections[0]!.instanceUrl,
    credentialRef: null, webhookMode: 'secret', webhookSecretRef: null, botUserId: '900', botLogin: 'patchpaw', projectIds: ['88'], enabled: true, createdAt: '', updatedAt: '' };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'fixture-token' }), { id: '900', username: 'patchpaw' });
  const retry = await deliverImmediately(fixture.root, stored!, { adapter, botLogin: 'patchpaw' });
  assert.equal(retry.item.status, 'delivered');
  assert.equal(fixture.control.modelCalls, modelCalls);
  assert.equal((await git(fixture.remote.bare, ['rev-list', '--count', `${before}..${after}`])).stdout.trim(), commits);
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), after);
});

test('GitLab custom read_write blocks an Agent-authored push and keeps Harness writeback authoritative', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'agent-push'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'custom_completed');
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), before);
  assert.equal((await readState(fixture.path))?.phase, 'custom_completed');
  assert.equal((await readState(fixture.path))?.current_head_sha, before);
  assert.equal((await readState(fixture.path))?.last_patchpaw_commit, null);
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report')?.item.status, 'delivered');
  assert.equal(fixture.control.modelCalls, 2, 'the blocked command is returned to the Agent as a tool error');
});

test('GitLab custom read_write fails closed when the remote MR head drifts before push', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.externalDrift = 'head'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  const after = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(result?.status, 'harness_failed'); assert.notEqual(after, before);
  assert.equal((await readState(fixture.path))?.phase, 'harness_failed');
  assert.equal((await readState(fixture.path))?.current_head_sha, before);
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'run_notice')?.item.status, 'delivered');
  assert.equal((await git(fixture.remote.bare, ['show', `${after}:drift.txt`])).stdout, 'feature drift\n');
  assert.equal((await git(fixture.remote.bare, ['log', '-1', '--format=%s', after])).stdout.trim(), 'External feature drift');
});

test('GitLab custom read_write fails closed when the target branch drifts before push', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.externalDrift = 'base'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const beforeFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const beforeMain = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'harness_failed');
  assert.equal((await readState(fixture.path))?.phase, 'harness_failed');
  assert.equal((await readState(fixture.path))?.current_head_sha, beforeFeature);
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'run_notice')?.item.status, 'delivered');
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), beforeFeature);
  assert.notEqual((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim(), beforeMain);
});

test('GitLab custom read_write rejects rewritten candidate history before push', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'rewrite'; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'harness_failed');
  assert.equal((await readState(fixture.path))?.phase, 'harness_failed');
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'run_notice')?.item.status, 'delivered');
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), before);
  assert.ok(fixture.control.apiCalls.every(call => !call.path.endsWith('/repository/commits')));
});

test('GitLab custom read_write rejects fork MRs before starting the Agent', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.fork = true; await addCustomCommand(fixture);
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'needs_human');
  assert.match(String((result as any).reason), /fork/i);
  assert.equal(fixture.control.normalModelCalls, 0);
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), before);
});

test('GitLab custom read_only keeps the existing non-writing behavior', async t => {
  const fixture = await workerFixture(t, 'custom'); fixture.control.customMode = 'no-op'; await addCustomCommand(fixture, 'read_only');
  await fixture.addComment(100, '@patchpaw /edit');
  const before = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'custom_completed');
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), before);
  assert.equal((await readState(fixture.path))?.phase, 'custom_completed');
  assert.equal((await readState(fixture.path))?.current_head_sha, before);
  assert.equal((await readState(fixture.path))?.last_patchpaw_commit, null);
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report')?.item.status, 'delivered');
});

test('GitLab conflict Approval Plan stays read-only until approval, then pushes the bound repair', async t => {
  const fixture = await workerFixture(t, 'conflict', true); await fixture.addComment(100, '@patchpaw /conflict');
  const initialFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const proposalResult = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(proposalResult?.status, 'awaiting_approval');
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), initialFeature);
  const planPublication = (await listOutbound(fixture.root)).find(value => value.item.purpose === 'approval_plan');
  assert.equal(planPublication?.item.status, 'delivered');
  const publishedPlan = await readCurrentApprovalPlan(fixture.path);
  assert.equal(publishedPlan?.plan.status, 'published');
  assert.equal(publishedPlan?.plan.publication?.remote_id, planPublication?.item.receipt?.id);
  fixture.control.mode = 'conflict'; await fixture.addComment(800, '@patchpaw /approval');
  const approvalResult = await runGitLabMergeRequest(fixture.config, repo, 3);
  const finalFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(approvalResult?.status, 'conflict_completed'); assert.notEqual(finalFeature, initialFeature);
  const state = await readState(fixture.path);
  assert.equal(state?.phase, 'conflict_completed');
  assert.equal(state?.current_head_sha, finalFeature);
  assert.equal(state?.last_patchpaw_commit, finalFeature);
  const approvedPlan = await readCurrentApprovalPlan(fixture.path);
  assert.equal(approvedPlan?.plan.status, 'approved');
  assert.equal(approvedPlan?.approval?.source_comment_id, 800);
  assert.equal(approvedPlan?.approval?.phase, 'completed');
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'delivery_report')?.item.status, 'delivered');
  assert.equal(fixture.control.normalModelCalls >= 3, true);
  assert.ok(fixture.control.apiCalls.some(value => value.path.endsWith('/users/17')));
  assert.ok(fixture.control.apiCalls.some(value => value.path.endsWith('/members/all/17')));
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('## Conflict 修复完成')));
});

test('GitLab worker /stop aborts the active generation and retains its workspace', async t => {
  const fixture = await workerFixture(t, 'stop'); fixture.control.holdNormalModel = true; await fixture.addComment(100, '@patchpaw /repair');
  const running = runGitLabMergeRequest(fixture.config, repo, 3);
  await fixture.modelReady;
  await fixture.addComment(101, '@patchpaw /stop');
  await new Promise(resolve => setTimeout(resolve, 400));
  fixture.control.releaseNormalModel?.();
  const result = await running;
  assert.equal(result?.status, 'stopped'); assert.equal((await readState(fixture.path))?.phase, 'stopped');
  const paused = await readFileIfPresent(`${fixture.path}.paused.json`);
  assert.ok(paused?.includes('workspaces'));
  assert.equal(fixture.control.normalModelCalls, 1);
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900));
  assert.equal((await listOutbound(fixture.root)).find(value => value.item.purpose === 'run_notice')?.item.status, 'delivered');
});

test('GitLab active /close is durably refused and never runs cleanup', async t => {
  const fixture = await workerFixture(t, 'active-close'); fixture.control.holdNormalModel = true; await fixture.addComment(100, '@patchpaw /repair');
  const running = runGitLabMergeRequest(fixture.config, repo, 3);
  await fixture.modelReady;
  await fixture.addComment(101, '@patchpaw /close');
  for (let attempt = 0; attempt < 20 && !fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('请先 /stop')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fixture.control.releaseNormalModel?.();
  const result = await running;
  assert.equal(result?.status, 'needs_human'); assert.equal((await readState(fixture.path))?.phase, 'needs_human');
  assert.equal((await readHumanReplies(fixture.path)).some(comment => comment.comment_id === 101), true);
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('请先 /stop')));
  assert.equal(fixture.control.normalModelCalls, 1);
  const state = await readState(fixture.path); assert.equal(state?.closed_at, undefined); assert.equal(state?.closed_through_comment_id, undefined);
  assert.equal(state?.handled_comment_ids?.includes(101), true); assert.equal(await hasHumanReplies(fixture.path), false);
  assert.equal((await runGitLabMergeRequest(fixture.config, repo, 3))?.status, 'mention_required'); assert.equal(fixture.control.normalModelCalls, 1);
});

test('GitLab provider failure publishes a classified durable MR Note', async t => {
  const fixture = await workerFixture(t, 'repair'); fixture.control.modelFailure = 'provider_429'; await fixture.addComment(100, '@patchpaw /repair');
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'provider_unavailable');
  assert.equal((result as any).failure.code, 'provider_upstream_unavailable');
  assert.equal((result as any).failure.retryable, true);
  assert.equal((result as any).failure.user_action, 'retry');
  assert.equal((result as any).failure.upstream_status, 429);
  assert.equal((result as any).failure.attempts, 4);
  assert.equal((await readState(fixture.path))?.phase, 'provider_unavailable');
  const runResult = JSON.parse(await readFile(join(fixture.root, 'runs', (result as any).run_id, 'result.json'), 'utf8'));
  assert.equal(runResult.status, 'provider_unavailable');
  assert.equal(runResult.failed_phase, 'repair');
  assert.equal(runResult.failure.code, 'provider_upstream_unavailable');
  assert.equal(JSON.parse(await readFile(join(fixture.root, 'runs', (result as any).run_id, 'notification.json'), 'utf8')).status, 'published');
  const runNotice = JSON.parse(await readFile(join(fixture.root, 'runs', (result as any).run_id, 'run-notice.json'), 'utf8'));
  assert.equal(runNotice.phase, 'repair');
  const trace = await readFile(join(fixture.root, 'runs', (result as any).run_id, 'trace.jsonl'), 'utf8');
  assert.match(trace, /"event":"run_error"/);
  const events = trace.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === 'run_notice_published'));
  assert.equal(events.filter(event => event.event === 'run_notice_pending').length, 0);
  const notice = fixture.control.remoteNotes.find(note => note.author.id === 900 && note.body.includes('模型服务暂时不可用'));
  assert.ok(notice);
  assert.match(notice.body, /阶段：`repair`/);
  assert.match(notice.body, /状态：`provider_unavailable`/);
  assert.match(notice.body, /provider_upstream_unavailable/);
  assert.match(notice.body, /HTTP 429/);
  assert.match(notice.body, /稍后重新发送原命令/);
  const outbox = (await listOutbound(fixture.root)).find(value => value.item.purpose === 'run_notice');
  assert.equal(outbox?.item.semantic_key, `run-notice:${(result as any).run_id}`);
  assert.equal(outbox?.item.status, 'delivered');
});

test('GitLab failure Note publication keeps the primary failure and does not rerun the model', async t => {
  const fixture = await workerFixture(t, 'repair'); fixture.control.modelFailure = 'provider_429'; fixture.control.failNotePublication = true;
  await fixture.addComment(100, '@patchpaw /repair');
  const result = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(result?.status, 'provider_unavailable');
  assert.equal((result as any).failure.code, 'provider_upstream_unavailable');
  assert.equal((await readState(fixture.path))?.phase, 'provider_unavailable');
  const runDir = join(fixture.root, 'runs', (result as any).run_id);
  assert.equal(JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')).failed_phase, 'repair');
  assert.equal(JSON.parse(await readFile(join(runDir, 'run-notice.json'), 'utf8')).phase, 'repair');
  assert.equal(JSON.parse(await readFile(join(runDir, 'notification.json'), 'utf8')).status, 'notification_failed');
  const events = (await readFile(join(runDir, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'run_notice_published').length, 1);
  const modelCalls = fixture.control.modelCalls;
  const stored = (await listOutbound(fixture.root)).find(value => value.item.purpose === 'run_notice');
  assert.ok(stored); assert.equal(stored!.item.status, 'blocked');
  fixture.control.failNotePublication = false;
  const connection: ScmConnection = { id: 'worker', kind: 'gitlab', instanceUrl: fixture.config.gitlabConnections[0]!.instanceUrl,
    credentialRef: null, webhookMode: 'secret', webhookSecretRef: null, botUserId: '900', botLogin: 'patchpaw', projectIds: ['88'], enabled: true, createdAt: '', updatedAt: '' };
  const adapter = new GitLabAdapter(connection, new GitLabClient({ baseUrl: connection.instanceUrl, token: 'fixture-token' }), { id: '900', username: 'patchpaw' });
  const retry = await deliverImmediately(fixture.root, stored!, { adapter, botLogin: 'patchpaw' });
  assert.equal(retry.item.status, 'delivered');
  assert.equal(fixture.control.modelCalls, modelCalls);
  assert.equal(fixture.control.remoteNotes.filter(note => note.author.id === 900 && note.body.includes('模型服务暂时不可用')).length, 1);
  const persisted = JSON.parse(await readFile(join(fixture.root, 'runs', (result as any).run_id, 'result.json'), 'utf8'));
  assert.equal(persisted.status, 'provider_unavailable');
  assert.equal(persisted.failure.code, 'provider_upstream_unavailable');
});

test('GitLab connection bootstrap failures persist terminal evidence', async t => {
  const cases: Array<{ name: string; setup: (fixture: WorkerFixture) => void; expected: string; targetRepo?: string }> = [
    { name: 'missing token', setup: fixture => { (fixture.config.gitlabConnections[0]! as { token?: string }).token = undefined; }, expected: 'gitlab_configuration_error' },
    { name: 'GitLab user auth failure', setup: fixture => { fixture.control.userFailure = { status: 401 }; }, expected: 'gitlab_auth_failed' },
    { name: 'GitLab user network failure', setup: fixture => { fixture.control.userFailure = 'network'; }, expected: 'gitlab_unavailable' },
    { name: 'bot identity unavailable', setup: fixture => { fixture.control.botIdentity = { id: 900, username: '' }; }, expected: 'gitlab_configuration_error' },
    { name: 'stale bot identity', setup: fixture => { fixture.config.gitlabConnections[0]!.botUserId = '901'; }, expected: 'gitlab_configuration_error' },
    { name: 'invalid storage key', setup: () => {}, expected: 'gitlab_configuration_error', targetRepo: 'gitlab:invalid' },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async child => {
      const fixture = await workerFixture(child, 'review'); testCase.setup(fixture);
      const targetRepo = testCase.targetRepo ?? repo;
      const result = await runGitLabMergeRequest(fixture.config, targetRepo, 3);
      assert.equal(result?.status, 'harness_failed');
      assert.equal((result as any).failure.code, testCase.expected);
      assert.equal((result as any).failure.scm_platform, 'gitlab');
      const runDir = join(fixture.root, 'runs', (result as any).run_id);
      const persisted = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8'));
      assert.equal(persisted.status, 'harness_failed');
      assert.equal(persisted.failed_phase, 'bootstrap');
      assert.equal(persisted.failure.code, testCase.expected);
      assert.equal(JSON.parse(await readFile(join(runDir, 'notification.json'), 'utf8')).status, 'not_attempted');
      assert.equal((await readState(statePath(patchpawPaths(fixture.root).state, targetRepo, 3)))?.active, false);
      const trace = await readFile(join(runDir, 'trace.jsonl'), 'utf8');
      assert.match(trace, /"event":"run_error"/);
      assert.match(trace, /bootstrap/);
    });
  }
});

async function readFileIfPresent(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
