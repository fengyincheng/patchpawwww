import { type TestContext } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../src/workspace/git.ts';
import { saveHumanReply } from '../../src/runner/human-feedback.ts';
import { statePath } from '../../src/runner/state.ts';
import { budget } from '../../src/harness/budget.ts';
import { nodeFileExists, nodeWriteFile } from './portable-commands.ts';

export type FixtureMode = 'fresh' | 'legacy';
type ModelReply = { tool: string; args: Record<string, unknown> } | { text: string };

// Shared in-process fixture: real temporary Git repos + durable state layout, mocked GitHub and
// model transports. Extracted verbatim from the comment-loop suite so lifecycle tests exercise
// the same battle-tested environment; `holdModel` is the only addition (a test-controlled stall
// inside the model handler, used to observe an active task from the outside).
export async function fixture(t: TestContext, initialMention = true, mode: FixtureMode = 'fresh') {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-comment-loop-'));
  const remote = join(root, 'remote'); await mkdir(remote);
  const cloneUrl = 'https://github.com/owner/lab.git';
  const gitConfig = join(root, 'gitconfig');
  await writeFile(gitConfig, `[url "file://${remote}"]\n\tinsteadOf = ${cloneUrl}\n`);
  await git(remote, ['init', '-b', 'main']);
  await git(remote, ['config', 'user.name', 'Fixture']);
  await git(remote, ['config', 'user.email', 'fixture@localhost']);
  await writeFile(join(remote, 'sample.txt'), 'before\n');
  await git(remote, ['add', '.']); await git(remote, ['commit', '-m', 'base']);
  const base = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(remote, ['branch', 'feature']);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { root, appId: 42, appSlug: 'patchpawwww', botLogin: 'patchpawwww[bot]', wakeTransport: 'memory' as const,
    privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), snapshotRoot: join(root, 'snapshots'), operatorLogin: 'operator' };
  const previousEnv = { key: process.env.ZAI_API_KEY, url: process.env.ZAI_BASE_URL, gitConfig: process.env.GIT_CONFIG_SYSTEM };
  process.env.GIT_CONFIG_SYSTEM = gitConfig;
  const poll = budget.ciPollMs;
  process.env.ZAI_API_KEY = 'fixture-secret'; process.env.ZAI_BASE_URL = 'https://model.fixture/v1'; budget.ciPollMs = 1;
  t.after(() => {
    budget.ciPollMs = poll;
    for (const [name, value] of [['ZAI_API_KEY', previousEnv.key], ['ZAI_BASE_URL', previousEnv.url], ['GIT_CONFIG_SYSTEM', previousEnv.gitConfig]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  });
  const calls: { path: string; body: any }[] = [], modelInputs: any[] = [];
  const control = { mode, commentStatus: 201, commentStatusSequence: undefined as number[] | undefined, installationFailures: 0, turn: 0, captureFails: false, prAuthor: 'owner', conversation: 'continue', conversationReadsCurrentBase: false, agentCommits: false,
    dropReviewAcknowledgement: false, reviewNeedsHelp: false, redAlways: false, repeatRepair: false,
    freshRepairToolPending: false,
    stopOnPublish: false, stopOnPoll: false, stopOnModel: false, stopReportFails: false, conflictRepair: false, approvalRepair: false, conflictRevision: false, humanConflict: false, pauseConflict: false, closeoutFails: false, mainSha: undefined as string | undefined, prHeadRepo: 'owner/lab' as string | null,
    holdModel: undefined as undefined | (() => Promise<void>) };
  const publishedReviews: any[] = [];
  const publishedComments: any[] = [];
  // The resolved status of every comment POST, recorded at decision time: tests that toggle
  // publication status must wait on a completed outcome, never on request arrival, because the
  // mock reads the control flag after an internal await.
  const commentOutcomes: number[] = [];
  const json = (data: unknown, status = 200) => {
    const response = new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: 'https://api.github.com/fixture' });
    return response;
  };
  const requestStop = async () => {
    await saveHumanReply(statePath(join(root, 'data/state'), 'owner/lab', 7), {
      repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id: 199, author: 'owner',
      body: '@patchpawwww /stop', url: 'https://github.com/owner/lab/pull/7#issuecomment-199' });
    await new Promise(resolve => setTimeout(resolve, 400));
  };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.hostname === 'model.fixture') {
      modelInputs.push(body);
      const stopping = body.tools.length === 1 && body.tools[0].function.name === 'submit_stop_report';
      if (stopping && control.stopReportFails) return json({ error: { message: 'stop report fixture unavailable' } }, 400);
      const freshResponses: ModelReply[] = [
        { tool: 'request_human_help', args: { reason: '测试需要产品决策：保留哪种行为？ evidence: sample.txt; fixture-secret' } },
        { tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: 'before', new_string: 'after' } },
        ...(control.agentCommits ? [{ tool: 'mastra_workspace_execute_command', args: { command: 'git add sample.txt && git commit -m "Agent authored fix"' } }] : []),
        { text: '修复完成：已完成候选修改，并由 Harness 继续确认工作区、提交与远端状态。' },
      ];
      const legacyResponses: ModelReply[] = [
        freshResponses[0], freshResponses[1],
        ...(control.agentCommits ? [freshResponses[2]] : []),
        { tool: 'request_repair_verification', args: { summary: 'Applied human choice', tests: [nodeFileExists('sample.txt')], validation_not_applicable: null } },
      ];
      const responses = mode === 'legacy' ? legacyResponses : freshResponses;
      const conversation = body.tools.some((tool: any) => tool.function.name === 'reply_to_pr');
      const promptText = body.messages.map((message: any) => String(message.content ?? '')).join('\n');
      const isConflict = mode === 'legacy'
        ? body.tools.some((tool: any) => tool.function.name === 'submit_conflict_proposal')
        : /## Prompt conflict\b/.test(promptText);
      const isCustom = promptText.includes('CUSTOM_TASK_MARKER');
      const isReview = mode === 'legacy'
        ? !isCustom && !conversation && !isConflict && !body.tools.some((tool: any) => tool.function.name === 'request_repair_verification')
        : /## Prompt review\b/.test(promptText);
      const conversationHasCurrentBaseEvidence = body.messages.some((message: any) => message.role === 'tool' && String(message.content ?? '').includes('current_base_tip'));
      const step = control.turn;
      const closing = body.tools.every((tool: any) => ['request_human_help', 'request_repair_verification', 'submit_task_closeout'].includes(tool.function.name));
      if (closing && control.closeoutFails) return json({ error: { message: 'fixture closeout failure' } }, 400);
      const repeated = step % 2 === 0
        ? { tool: 'mastra_workspace_edit_file', args: { path: 'sample.txt', old_string: step === 0 ? 'before' : `after-${step / 2}`, new_string: `after-${step / 2 + 1}` } }
        : { tool: 'request_repair_verification', args: { summary: '红测源于兼容问题，已调整实现并通过本地验证。', tests: [nodeFileExists('sample.txt')], validation_not_applicable: null } };
      const conflict = { tool: 'submit_conflict_proposal', args: { summary: '双方修改了同一行，建议先确认兼容方向。',
        pr_intent: 'PR 将 sample.txt 改为 feature 行为。', current_base_intent: '当前 main 将 sample.txt 改为 main 行为。',
        conflicts: [{ path: 'sample.txt', issue: '同一行内容发生冲突。', pr_side: 'feature', base_side: 'main',
          proposed_resolution: '保留 PR 意图并兼容 main 行为。', disagreement_or_tradeoff: '需要人类确认语义取舍。' }],
        affected_files: ['sample.txt'], verification_plan: [nodeFileExists('sample.txt')],
        risks_or_open_questions: ['需要确认双方行为的优先级。'], human_markdown_summary: '这是一个只读提案，等待明确 /approval。' } };
      const approvalRepair = control.approvalRepair;
      if (approvalRepair) control.approvalRepair = false;
      let naturalText: string | undefined;
      const freshWrite = { tool: 'mastra_workspace_execute_command', args: { command: nodeWriteFile('sample.txt', 'resolved\n') + ' && git add sample.txt' } };
      const reply = stopping ? { tool: 'submit_stop_report', args: { summary: '收到停止请求。当前正在调查架构选择，工作区已保留，等待你的意见。' } } : isCustom
        ? undefined : isConflict && control.humanConflict
        ? responses[0]
        : isConflict && control.pauseConflict && step > 0
        ? (closing ? { tool: 'submit_task_closeout', args: { status: 'budget_exhausted', summary: '预算耗尽，保留候选',
          completed: ['Git 冲突已解决'], remaining: ['验收候选'], current_investigation: '调查 threadId 参数',
          validation: { passed: [], failed: [] }, workspace_state: 'dirty', human_question: null } } : undefined)
        : isReview ? (control.reviewNeedsHelp ? { tool: 'request_human_help', args: { reason: '还没有改代码，我现在就想请人确认需求。' } } : undefined)
        : conversation && control.conversationReadsCurrentBase && !conversationHasCurrentBaseEvidence
        ? { tool: 'read_current_base_file', args: { path: 'current-base-only.txt' } }
        : conversation && isConflict && mode === 'legacy' && control.conflictRevision ? (control.turn++, conflict)
        : conversation ? { tool: 'reply_to_pr', args: { body: '可以正常沟通。这条消息只需要回答，不需要修改代码。' } }
        : approvalRepair ? (control.turn = responses.length - 1, control.conflictRepair = false, freshWrite)
        : control.conflictRepair ? (mode === 'legacy'
          ? (control.turn++, conflict)
          : body.tools.some((tool: any) => /mastra_workspace_(edit_file|write_file|execute_command)/.test(tool.function.name))
            ? (control.turn = responses.length - 1, control.conflictRepair = false, freshWrite)
            : (naturalText = '冲突分析计划：已检查未合并索引、PR 意图与当前 base，等待 Harness 的审批阶段。', undefined))
        : mode === 'fresh' && control.repeatRepair
        ? control.freshRepairToolPending
          ? (control.freshRepairToolPending = false, naturalText = '修复完成：已完成本轮候选修改，并返回自然语言结果。', undefined)
          : (control.freshRepairToolPending = true, control.turn++, { tool: 'mastra_workspace_execute_command', args: { command: nodeWriteFile('sample.txt', `repair-${control.turn}\n`) } })
        : control.repeatRepair ? (control.turn++, repeated) : responses[control.turn++];
      if (isReview && !reply) naturalText = '评审完成：未发现需要立即处理的问题；局限性已在报告中说明。';
      if (isCustom && !reply) naturalText = 'CUSTOM_NATURAL_LANGUAGE_ANSWER';
      if (reply && 'text' in reply && !naturalText) naturalText = reply.text;
      const toolReply = reply && 'tool' in reply ? reply : undefined;
      // Stall only AFTER the reply is computed: the aborted request's turn increment must
      // be synchronous, so a discarded in-flight response can never mutate shared fixture
      // state late and poison the deterministic sequence of a later run.
      if (!stopping && control.stopOnModel) {
        control.stopOnModel = false;
        await requestStop();
      }
      if (!stopping && control.holdModel) await control.holdModel();
      return json({ id: `response-${control.turn}`, model: 'fixture', choices: [{ index: 0,
        message: { role: 'assistant', content: naturalText ?? (toolReply ? '' : mode === 'legacy' ? JSON.stringify({ summary: 'Human choice verified', recommendation: 'approve', findings: [], limitations: [] }) : '任务完成：已检查当前证据并返回自然语言结果。'),
          ...(toolReply ? { tool_calls: [{ id: `call-${modelInputs.length}`, type: 'function', function: { name: toolReply.tool, arguments: JSON.stringify(toolReply.args) } }] } : {}) },
        finish_reason: isCustom ? 'stop' : toolReply ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    calls.push({ path, body });
    if (control.stopOnPoll && path.endsWith('/check-runs')) { control.stopOnPoll = false; await requestStop(); }
    if (control.stopOnPublish && body && (path.endsWith('/comments') || path.endsWith('/reviews'))) { control.stopOnPublish = false; await requestStop(); }
    if (path === '/app') return json({ slug: 'patchpawwww' });
    if (path === '/repos/owner/lab/installation') {
      if (control.installationFailures > 0) { control.installationFailures--; return json({ message: 'transient installation lookup failure' }, 503); }
      return json({ id: 42 });
    }
    if (path === '/app/installations/42/access_tokens') return json({ token: 'ghs_fixture_token', expires_at: '2099-01-01T00:00:00Z' }, 201);
    const head = (await git(remote, ['rev-parse', 'feature'])).stdout.trim();
    if (path === '/repos/owner/lab') return control.captureFails ? json({ message: 'Fixture inspection failure' }, 403)
      : json({ id: 10, full_name: 'owner/lab', private: true, clone_url: cloneUrl });
    if (path === '/repos/owner/lab/pulls/7') return json({ number: 7, state: 'open', title: 'Fixture', body: '', user: { login: control.prAuthor },
      html_url: 'https://github.com/owner/lab/pull/7', base: { ref: 'main', sha: control.mainSha ?? base, repo: { id: 10 } }, head: { sha: head, ref: 'feature', repo: control.prHeadRepo ? { id: control.prHeadRepo === 'owner/lab' ? 10 : 11, full_name: control.prHeadRepo, clone_url: cloneUrl } : null } });
    if (path === '/repos/owner/lab/branches/main') return json({ commit: { sha: control.mainSha ?? base } });
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ name: 'unit', status: 'completed', conclusion: control.redAlways || head === base ? 'failure' : 'success', html_url: 'https://github.com/owner/lab/actions/runs/9' }] });
    if (path.endsWith('/status')) return json({ state: 'pending', statuses: [] });
    if (path.endsWith('/actions/runs')) return json({ total_count: 0, workflow_runs: [] });
    if (path.endsWith('/issues/7/comments')) {
      if (!body) return json(publishedComments);
      // An optional per-post status sequence lets a test fail one specific publication
      // (e.g. a /close completion notice) while the rest keep the default behavior.
      const status = control.commentStatusSequence?.length ? control.commentStatusSequence.shift()! : control.commentStatus;
      const comment = { id: 51 + publishedComments.length, html_url: 'https://github.com/owner/lab/pull/7#issuecomment-51',
        body: body.body, user: { login: 'patchpawwww[bot]', type: 'Bot' } };
      if (status === 201) publishedComments.push(comment);
      commentOutcomes.push(status);
      return json(status === 201 ? comment : { message: 'Forbidden fixture-secret' }, status);
    }
    if (path.endsWith('/pulls/7/reviews')) {
      if (!body) return json(publishedReviews);
      const published = { id: 52, html_url: 'https://github.com/owner/lab/pull/7#pullrequestreview-52', commit_id: head,
        body: body.body, user: { login: 'patchpawwww[bot]', type: 'Bot' }, state: 'COMMENTED', submitted_at: '2026-09-06T14:00:00Z' };
      publishedReviews.push(published);
      if (control.dropReviewAcknowledgement) { control.dropReviewAcknowledgement = false; throw new Error('Lost API acknowledgement'); }
      return json(published, 200);
    }
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  });
  const mention = (body: string, comment_id = 100) => saveHumanReply(statePath(join(root, 'data/state'), 'owner/lab', 7), {
    repo: 'owner/lab', pr_number: 7, installation_id: 42, comment_id, author: 'owner', body,
    url: `https://github.com/owner/lab/pull/7#issuecomment-${comment_id}`, author_association: 'OWNER', source_event_id: `fixture-delivery-${comment_id}` });
  if (initialMention) await mention('@patchpawwww /CI');
  return { config, root, base, calls, modelInputs, control, mention, remote, publishedReviews, publishedComments, commentOutcomes };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
