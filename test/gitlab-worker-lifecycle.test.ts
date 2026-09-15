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
import { hasHumanReplies, saveHumanReply, readHumanReplies } from '../src/runner/human-feedback.ts';
import { statePath, readState } from '../src/runner/state.ts';
import { patchpawPaths } from '../src/config/paths.ts';
import { bootstrapControlPlane, closeControlPlaneDb, createCommand, listPrompts, listSkills, openControlPlaneDb, setProviderCredential } from '../src/control-plane/index.ts';

const repo = 'gitlab:worker:project:88';

function json(data: unknown, status = 200) {
  return { data, status };
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, result: ReturnType<typeof json>) {
  const body = JSON.stringify(result.data);
  response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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
  mode: 'review' | 'repair' | 'conflict' | 'stop' | 'active-close';
  modelCalls: number;
  normalModelCalls: number;
  repairStep: number;
  holdNormalModel: boolean;
  modelStarted?: () => void;
  releaseNormalModel?: () => void;
  mrState: 'opened' | 'closed' | 'merged';
  nextNoteId: number;
  remoteNotes: any[];
  apiCalls: Array<{ method: string; path: string }>;
  mrReads: Array<{ sha: string; targetSha: string }>;
}

interface WorkerFixture {
  root: string;
  remote: Awaited<ReturnType<typeof createRemote>>;
  cloneUrl: string;
  control: WorkerControl;
  path: string;
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
  const control: WorkerControl = { mode, modelCalls: 0, normalModelCalls: 0, repairStep: 0, holdNormalModel: false,
    mrState: 'opened', nextNoteId: 700, remoteNotes: [], apiCalls: [], mrReads: [] };
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
  try {
    const repository = bootstrap.repositories[0]!;
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
  const responseForModel = async (body: any) => {
    control.modelCalls++;
    const tools = (body.tools ?? []) as Array<{ function?: { name?: string } }>;
    const toolNames = new Set(tools.map(tool => tool.function?.name));
    const stopCloseout = toolNames.size === 1 && toolNames.has('submit_stop_report');
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
      else tool = { name: 'request_repair_verification', args: { summary: '修复完成。', tests: ['test -f sample.txt'], validation_not_applicable: null } };
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
      if (url.pathname === '/gitlab/api/v4/user') return sendJson(response, json({ id: 900, username: 'patchpaw', bot: true, state: 'active' }));
      if (url.pathname === '/gitlab/api/v4/projects/88') return sendJson(response, json({ id: 88, path_with_namespace: 'group/repo', web_url: `${instanceUrl}/group/repo`, http_url_to_repo: cloneUrl }));
      if (url.pathname === '/gitlab/api/v4/projects/88/merge_requests/3') {
        const head = (await git(remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
        const main = (await git(remote.bare, ['rev-parse', 'refs/heads/main'])).stdout.trim();
        control.mrReads.push({ sha: head, targetSha: main });
        return sendJson(response, json({ iid: 3, state: control.mrState, source_project_id: 88, target_project_id: 88, source: { path_with_namespace: 'group/repo' },
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
  return { root, remote, cloneUrl, control, path, config, modelReady, addComment: async (id: number, body: string, authorId = '17') => {
    const createdAt = new Date(Date.now() + id * 1000).toISOString();
    control.remoteNotes.push({ id, body, author: { id: Number(authorId), username: authorId === '17' ? 'developer' : 'operator' }, web_url: `https://git.example/note/${id}`, created_at: createdAt, system: false });
    await saveHumanReply(path, { repo, pr_number: 3, comment_id: id, author: authorId === '17' ? 'developer' : 'operator', author_id: authorId,
      body, url: `https://git.example/group/repo/-/merge_requests/3#note_${id}`, created_at: createdAt, source_event_id: `fixture-${id}`, platform: 'gitlab', connection_id: 'worker', project_id: '88', repository_path: 'group/repo' });
  } };
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
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('## GitLab repair')));
  assert.ok(fixture.control.apiCalls.filter(value => value.path.endsWith('/merge_requests/3')).length >= 2);
});

test('GitLab conflict proposal stays read-only until approval, then pushes the bound repair', async t => {
  const fixture = await workerFixture(t, 'conflict', true); await fixture.addComment(100, '@patchpaw /conflict');
  const initialFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  const proposalResult = await runGitLabMergeRequest(fixture.config, repo, 3);
  assert.equal(proposalResult?.status, 'awaiting_approval');
  assert.equal((await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim(), initialFeature);
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('Conflict Proposal')));
  fixture.control.mode = 'conflict'; await fixture.addComment(800, '@patchpaw /approval');
  const approvalResult = await runGitLabMergeRequest(fixture.config, repo, 3);
  const finalFeature = (await git(fixture.remote.bare, ['rev-parse', 'refs/heads/feature'])).stdout.trim();
  assert.equal(approvalResult?.status, 'repair_completed'); assert.notEqual(finalFeature, initialFeature);
  assert.equal((await readState(fixture.path))?.phase, 'repair_completed');
  assert.equal(fixture.control.normalModelCalls >= 3, true);
  assert.ok(fixture.control.apiCalls.some(value => value.path.endsWith('/users/17')));
  assert.ok(fixture.control.apiCalls.some(value => value.path.endsWith('/members/all/17')));
  assert.ok(fixture.control.remoteNotes.some(note => note.author.id === 900 && note.body.includes('GitLab Conflict 修复完成')));
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
  assert.equal(fixture.control.remoteNotes.filter(note => note.author.id === 900).length, 0);
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

async function readFileIfPresent(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
