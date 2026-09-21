import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapControlPlane,
  closeControlPlaneDb,
  copyPublicPrompt,
  createCommand,
  createPrompt,
  deletePrompt,
  getCommandByName,
  getRepositoryByName,
  listPrompts,
  openControlPlaneDb,
  resolveExecution,
  updateCommand,
  updatePrompt,
  type ControlPlaneDb,
} from '../src/control-plane/index.ts';
import { listBuiltinAssetMigrations, runBuiltinAssetMigrations } from '../src/control-plane/builtin-migrations.ts';
import { findMarker, contentDigest, createId } from '../src/control-plane/common.ts';
import { loadOperation } from '../src/operation/load.ts';

const ENV = { ZAI_MODEL: 'glm-test-builtin-assets' };

const LEGACY_PROMPTS: Record<string, string> = {
  review: `对照当前 base/main 评审所提供的当前 PR head。这是一次独立的只读 /review 任务：CI 全绿与可合并性不是前提条件。除非证据表明如此，不要声称它们已被验证。
面向人类读者的摘要、问题标题/说明与局限性用中文书写；按原样保留代码标识符、文件路径、必要的源码引用，以及要求的 JSON 键与枚举值。勤换行，多用md渲染，注意可读性。
使用 git_diff 与原生读取/搜索工具检查改动与相关代码。当你需要当前目标分支的确切内容时，使用 read_current_base_file、grep_current_base 和 list_current_base_files；它们的修订版本由 Harness 固定，输出中包含来源信息。本任务的工具面是只读的。
不要自行发布评审。返回合法的 ReviewResult 即完成你的职责；Harness 会在你的回合结束后机械地发布它。缺少 reply_to_pr 或其他 GitHub 发布工具不构成阻塞，其本身也绝不是请求 request_human_help 的理由。
报告本 PR 引入的可操作缺陷，并给出具体的触发条件与后果。不要报告无关的既存问题，也不要编造问题。
零发现是合法的。行号指向最终 head。如实说明检查的局限性。
只返回 JSON：{"summary":"...","recommendation":"approve|changes_requested|comment","findings":[{"path":"...","line":1,"severity":"high|medium|low","title":"...","evidence":"..."}],"limitations":[]}。`.trim(),
  conflict: `分析本 PR head 与当前 base/main 的真实合并，同时保持 PR 意图与 main 上的兼容行为。
在提出方向之前，先检查实际的未合并索引（unmerged index）、冲突标记、相关实现与测试。
使用 Harness 提供的只读工作区与当前 base 的确切证据。从仓库自身发现合适的验证命令，但不要编辑文件，也不要运行会写入工作区的命令。
用 \`submit_conflict_proposal\` 只提交一份结构化冲突提案。说明 PR 意图、当前 base 意图、每个冲突及其双方、建议的解决方案与取舍、受影响文件、验证计划、风险/待决问题，以及一段人类可读的摘要。
在明确的 \`/approval\` 之前，不要修复、暂存、提交、推送，也不要暗示普通讨论即授权修复。只读能力由 Harness 而非本提示词强制。`.trim(),
  conversation: `在对话上下文中回应新收到的人类 PR 评论。
提问、讨论、状态询问与“要求回复”都不构成代码修改请求。如有帮助，可阅读相关代码或 PR 评论。当问题涉及最新目标分支时，使用 read_current_base_file、grep_current_base 或 list_current_base_files；这些工具由 Harness 固定到本次运行所获取的当前 base，并在结果中标明其修订版本。然后用 reply_to_pr 提交你的实际回答并结束。不要求固定的确认模板。
这是一次普通提及，不是 slash-command 任务。只讨论与回答；不要启动修复或评审。请说明 @bot /conflict（别名 /confict）、/review 或 /CI 会启动对应任务；/stop 会暂停进行中的任务并请求其进度报告。随附的保留工作区属于被暂停的任务：只能以只读方式讨论，之后用明确的对应任务命令继续。当随附一份待处理的 Conflict Proposal 且 \`submit_conflict_proposal\` 工具可用时，讨论可以提交修订后的结构化提案；这仍然是只读的，并且依然等待 \`/approval\`。“同意”“继续”或“请修复”之类的普通措辞不构成批准。如果意图不明确，或一条评论里给了多个命令，请让人类每条评论只发一个命令。更早的命令是上下文，不是再次授权。
你拥有只读代码工具。不要声称你未亲自观察到的编辑、测试、CI 结果或动作。评论中不要包含凭据或原始长日志。普通的最终文本不会被发布；请用 reply_to_pr 提交你的回答。`.trim(),
  'ci-repair': `用 read_ci_evidence 获取完整分页日志，调查当前 PR head 实际失败的 CI 证据。
只修复本 PR 在当前 main 上正常工作所需的本地、小型兼容性/适配问题。
如果该失败需要新的产品决策、大规模重构、不可用的外部资源，或与本 PR 无关，请携带证据请求人类帮助。
检查仓库与工作流，挑选相关验证命令，进行修复并运行它们。不要禁用检查、弱化或删除测试，也不要引入无关设计。
你可以在本地提交修复，也可以把改动留给 runner。独立验证之后，runner 会复用你的提交，必要时新建提交，然后发布。不要直接 push。`.trim(),
  'repair-completion': `准备好后，调用 request_repair_verification，附上摘要以及你发现的确切、可重复的验证/测试命令。
你的摘要就是中文交付报告：说明原因、你改了什么，以及验证如何支持该修复。Harness 会在发布后补充提交与远端 CI 证据。
如果没有适用的测试，在 validation_not_applicable 中说明原因；否则将它设为 null。
Harness 会检查实际 Git 状态并独立重跑测试。只有 Harness 能判定 repaired。
自本次修复任务开始以来 HEAD 未变化、工作区干净且没有待处理的合并，这不构成一次修复。如果没有正当改动，请通过 request_human_help 说明情况，而不是声称已修复。
Harness 只对最终候选运行测试；原始测试/配置及其改动会作为证据保留，绝不会覆盖回你的工作之上。请说明合理的测试改动，并保持预期的覆盖范围，而不是弱化断言。格式化 diff-check 警告不阻塞完成；真实未解决的冲突与失败的测试则会阻塞。
如果验证失败，其真实证据会在同一对话中返回：继续修复并再次请求验证。
如果需要人类决策或超出范围的工作，请调用 request_human_help。其原因会作为 PR 评论发布：包含阻塞点、简明证据，以及需要人类给出的确切问题或动作。不要包含凭据或原始完整日志。
普通说明是可以的；最终回复文本或 JSON 永远不是修复完成的信号。`.trim(),
  'repair-closeout': '常规修复执行预算已耗尽。在同一线程中进入 closeout 模式。不要编辑，也不要运行命令。你最多有 {{closeoutSteps}} 个模型步骤。提交 submit_task_closeout，写明确切已完成/剩余的工作、最后一次进行的调查、验证与发布状态。如果下一个决策属于人类，使用 request_human_help。如果已就绪，请求 request_repair_verification；成功与否仍由 Harness 判定。最后的验证问题：{{lastIssue}}',
  'repair-no-verification': '未提交验证请求。准备好后调用 request_repair_verification；若被阻塞则调用 request_human_help。最终回复文本不会提交结果。',
  'repair-verification-empty': '验证请求既没有测试，也没有“不适用”的理由。请发现相关的验证命令，或说明为何没有适用项，然后调用 request_repair_verification。',
  'runtime-budget': '本轮剩余 {{remaining}} 个执行步骤。{{guidance}} 如果已就绪，调用 request_repair_verification；如果下一个决策属于人类，调用 request_human_help。否则准备一份精确的 closeout。工具仍会正常执行。',
};

/**
 * Build a runtime database that predates the plan-mode builtin: bootstrap the
 * current schema, then remove the plan-mode assets/markers and roll the built-in
 * /conflict back to its pre-approval permission. This is the exact upgrade the
 * production incident exposed.
 */
async function oldRuntimeDb() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-builtin-'));
  await bootstrapControlPlane({ root, env: ENV, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(root);
  await db.execute(`DELETE FROM command_prompts WHERE prompt_asset_id IN (SELECT id FROM prompt_assets WHERE slug = 'plan-mode')`);
  await db.execute(`DELETE FROM prompt_assets WHERE slug = 'plan-mode'`);
  await db.execute(`DELETE FROM bootstrap_markers WHERE seed_key LIKE '%plan-mode%'`);
  await db.execute(`UPDATE commands SET permission = 'read_write' WHERE slash_name = 'conflict'`);
  return { root, db };
}

/** A current runtime where the builtin contract is already fully converged. */
async function freshRuntimeDb() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-builtin-fresh-'));
  await bootstrapControlPlane({ root, env: ENV, repositories: [{ fullName: 'owner/lab' }] });
  return { root, db: await openControlPlaneDb(root) };
}

/**
 * Insert a malformed builtin Prompt directly, bypassing the createPrompt
 * ingress guard. This simulates an older runtime (or an out-of-band DB edit)
 * whose rows predate the reserved-identity guard; the migration must still
 * fail closed rather than adopt or overwrite the contradictory identity.
 */
async function insertMalformedPrompt(db: ControlPlaneDb, input: {
  scope: 'public' | 'repository'; repositoryId?: string; slug: string; role: string | null; content: string;
}) {
  const id = createId();
  const now = new Date().toISOString();
  await db.execute(`INSERT INTO prompt_assets(id, scope, repository_id, slug, title, role, content, enabled, revision,
      source_public_id, source_public_revision, created_at, updated_at)
    VALUES (:id, :scope, :repository_id, :slug, :title, :role, :content, 1, 1, NULL, NULL, :created_at, :updated_at)`, {
    id, scope: input.scope, repository_id: input.repositoryId ?? null, slug: input.slug, title: input.slug,
    role: input.role, content: input.content, created_at: now, updated_at: now,
  });
  await db.execute(`INSERT INTO bootstrap_markers(id, repository_id, seed_key, resource_kind, resource_id, source_digest, source_revision, state, created_at, updated_at)
    VALUES (:id, :repository_id, :seed_key, 'prompt', :resource_id, :source_digest, 1, 'override', :created_at, :updated_at)`, {
    id: createId(), repository_id: input.repositoryId ?? null,
    seed_key: `${input.scope === 'public' ? 'public-prompt' : 'prompt'}:${input.slug}`,
    resource_id: id, source_digest: contentDigest(input.content), created_at: now, updated_at: now,
  });
  return id;
}

async function writeHistoricalCommandBindings(
  db: ControlPlaneDb,
  commandId: string,
  bindings: readonly { assetId: string; bindingKind: 'main' | 'common' | 'auxiliary' }[],
  permission?: 'read_write' | 'read_write_approval',
) {
  await db.execute('DELETE FROM command_prompts WHERE command_id = :command_id', { command_id: commandId });
  for (const [index, binding] of bindings.entries()) {
    await db.execute(`INSERT INTO command_prompts(command_id, prompt_asset_id, position, enabled, binding_kind)
      VALUES (:command_id, :prompt_asset_id, :position, 1, :binding_kind)`, {
      command_id: commandId, prompt_asset_id: binding.assetId, position: index + 1, binding_kind: binding.bindingKind,
    });
  }
  if (permission) await db.execute('UPDATE commands SET permission = :permission WHERE id = :id', { id: commandId, permission });
}

test('builtin migration upgrades an old runtime DB and converges the read_write_approval contract', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    assert.equal((await listPrompts(db, { scope: 'public' })).some(asset => asset.slug === 'plan-mode'), false);

    const reports = await runBuiltinAssetMigrations(db);
    assert.equal(reports.length, 2);
    assert.ok(reports.some(report => report.migrationId === 'builtin-assets-v1-plan-mode'));

    const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    assert.equal(publicPlan.role, 'plan-mode');
    assert.equal(publicPlan.content, loadOperation('plan-mode'));
    assert.equal(publicPlan.enabled, true);
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'seeded');

    const repoPlan = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === 'plan-mode')!;
    assert.equal(repoPlan.sourcePublicId, publicPlan.id);
    assert.equal(repoPlan.sourcePublicRevision, publicPlan.revision);
    assert.equal((await findMarker(db, repository.id, 'prompt:plan-mode'))?.state, 'seeded');

    const conflict = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(conflict.permission, 'read_write_approval');
    assert.equal(conflict.promptBindings.some(binding => binding.enabled && binding.bindingKind === 'auxiliary' && binding.assetId === repoPlan.id), true);
    const repositoryPrompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    assert.deepEqual(conflict.promptBindings.map(binding => repositoryPrompts.find(asset => asset.id === binding.assetId)?.role),
      ['conflict', 'repair-closeout', 'stop-closeout', 'plan-mode', 'shared']);

    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'conflict', executionId: 'e1' });
    assert.equal(resolved.permission, 'read_write_approval');
    assert.equal(resolved.prompts.some(asset => asset.role === 'plan-mode'), true);
  } finally { closeControlPlaneDb(db); }
});

test('v1 then v2 converges the pre-v1 conflict verification layout', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const promptByRole = new Map(prompts.map(asset => [asset.role ?? asset.slug, asset]));
    const verificationRoles = ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty'];
    const oldBindings = [
      { assetId: promptByRole.get('conflict')!.id, bindingKind: 'main' as const },
      ...verificationRoles.map(role => ({ assetId: promptByRole.get(role)!.id, bindingKind: 'auxiliary' as const })),
      { assetId: promptByRole.get('repair-closeout')!.id, bindingKind: 'auxiliary' as const },
      { assetId: promptByRole.get('stop-closeout')!.id, bindingKind: 'auxiliary' as const },
      { assetId: promptByRole.get('shared')!.id, bindingKind: 'common' as const },
    ];
    const conflict = (await getCommandByName(db, repository.id, 'conflict'))!;
    await writeHistoricalCommandBindings(db, conflict.id, oldBindings, 'read_write');

    const beforeV1 = await getCommandByName(db, repository.id, 'conflict');
    assert.equal(beforeV1!.permission, 'read_write');
    assert.deepEqual(beforeV1!.promptBindings.map(binding => prompts.find(asset => asset.id === binding.assetId)?.role), [
      'conflict', ...verificationRoles, 'repair-closeout', 'stop-closeout', 'shared',
    ]);

    const v1Reports = await runBuiltinAssetMigrations(db, { only: ['builtin-assets-v1-plan-mode'] });
    assert.equal(v1Reports.length, 1);
    const afterV1 = (await getCommandByName(db, repository.id, 'conflict'))!;
    const afterV1Prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    assert.equal(afterV1.permission, 'read_write_approval');
    assert.deepEqual(afterV1.promptBindings.map(binding => afterV1Prompts.find(asset => asset.id === binding.assetId)?.role), [
      'conflict', ...verificationRoles, 'repair-closeout', 'stop-closeout', 'plan-mode', 'shared',
    ]);

    const v2Reports = await runBuiltinAssetMigrations(db, { only: ['builtin-assets-v2-opaque-output'] });
    const opaque = v2Reports.find(report => report.migrationId === 'builtin-assets-v2-opaque-output')!;
    assert.ok(opaque.actions.some(action => action.action === 'command_layout_converged'
      && action.detail === 'conflict_v1_verification_with_plan_mode_before_shared → conflict_current_read_write_approval'));

    const afterV2 = (await getCommandByName(db, repository.id, 'conflict'))!;
    const afterV2Prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    assert.equal(afterV2.permission, 'read_write_approval');
    assert.deepEqual(afterV2.promptBindings.map(binding => afterV2Prompts.find(asset => asset.id === binding.assetId)?.role), [
      'conflict', 'repair-closeout', 'stop-closeout', 'plan-mode', 'shared',
    ]);

    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'conflict', executionId: 'v1-v2-conflict' });
    assert.equal(resolved.permission, 'read_write_approval');
    const verificationRoleSet = new Set(verificationRoles);
    assert.equal(resolved.snapshot.composition.parts.some(part => part.role !== null && verificationRoleSet.has(part.role)), false);
    assert.equal((await listBuiltinAssetMigrations(db)).length, 2);
  } finally { closeControlPlaneDb(db); }
});

test('opaque-output migration converges known legacy Prompt bodies and command layouts', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const repositoryPrompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const promptByRole = new Map(repositoryPrompts.map(asset => [asset.role ?? asset.slug, asset]));

    for (const [slug, content] of Object.entries(LEGACY_PROMPTS)) {
      const publicAsset = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === slug)!;
      await updatePrompt(db, publicAsset.id, { content }, { expectedRevision: publicAsset.revision });
      const repositoryAsset = promptByRole.get(slug)!;
      await updatePrompt(db, repositoryAsset.id, { content }, { expectedRevision: repositoryAsset.revision });
    }

    const publicLegacy = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review-json-retry')!;
    const repositoryLegacy = await copyPublicPrompt(db, repository.id, publicLegacy.id);
    const replaceCommandBindings = async (
      slashName: 'review' | 'ci' | 'conflict',
      auxiliaryRoles: string[],
      permission?: 'read_write' | 'read_write_approval',
      planModeTail = false,
    ) => {
      const command = (await getCommandByName(db, repository.id, slashName))!;
      const mainRole = slashName === 'review' ? 'review' : slashName === 'ci' ? 'ci-repair' : 'conflict';
      const auxiliaryBindings = [
        ...auxiliaryRoles.map((role, index) => ({ assetId: role === 'review-json-retry' ? repositoryLegacy.id : promptByRole.get(role)!.id,
          position: index + 2, enabled: true, bindingKind: 'auxiliary' as const })),
      ];
      const bindings = [
        { assetId: promptByRole.get(mainRole)!.id, position: 1, enabled: true, bindingKind: 'main' as const },
        ...auxiliaryBindings,
        { assetId: promptByRole.get('shared')!.id, position: auxiliaryBindings.length + 2, enabled: true, bindingKind: 'common' as const },
        ...(planModeTail ? [{ assetId: promptByRole.get('plan-mode')!.id, position: auxiliaryBindings.length + 3, enabled: true, bindingKind: 'auxiliary' as const }] : []),
      ];
      await updateCommand(db, command.id, { ...(permission ? { permission } : {}), promptBindings: bindings }, { expectedRevision: command.revision });
    };
    await replaceCommandBindings('review', ['review-json-retry', 'stop-closeout']);
    await replaceCommandBindings('ci', ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty', 'repair-closeout', 'stop-closeout'], 'read_write_approval', true);
    await replaceCommandBindings('conflict', ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty', 'repair-closeout', 'stop-closeout'], 'read_write_approval', true);

    const reports = await runBuiltinAssetMigrations(db);
    const opaque = reports.find(report => report.migrationId === 'builtin-assets-v2-opaque-output')!;
    assert.ok(opaque.actions.some(action => action.action === 'converged_legacy'));
    assert.ok(opaque.actions.some(action => action.action === 'binding_removed' && action.detail === 'review-json-retry'));
    assert.ok(opaque.actions.some(action => action.action === 'command_layout_converged' && action.assetKey === 'conflict'));

    for (const slug of Object.keys(LEGACY_PROMPTS)) {
      const expected = loadOperation(slug);
      assert.equal((await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === slug)?.content, expected, `public ${slug}`);
      assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === slug)?.content, expected, `repository ${slug}`);
    }

    const review = (await getCommandByName(db, repository.id, 'review'))!;
    assert.deepEqual(review.promptBindings.map(binding => repositoryPrompts.find(asset => asset.id === binding.assetId)?.role), ['review', 'stop-closeout', 'shared']);
    assert.equal(review.promptBindings.some(binding => binding.assetId === repositoryLegacy.id), false);
    const ci = (await getCommandByName(db, repository.id, 'ci'))!;
    assert.equal(ci.permission, 'read_write_approval');
    assert.deepEqual(ci.promptBindings.map(binding => repositoryPrompts.find(asset => asset.id === binding.assetId)?.role), ['ci-repair', 'repair-closeout', 'stop-closeout', 'plan-mode', 'shared']);
    const conflict = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(conflict.permission, 'read_write_approval');
    assert.deepEqual(conflict.promptBindings.map(binding => repositoryPrompts.find(asset => asset.id === binding.assetId)?.role), ['conflict', 'repair-closeout', 'stop-closeout', 'plan-mode', 'shared']);

    const resolvedReview = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'review', executionId: 'opaque-review' });
    assert.equal(resolvedReview.outputContract.kind, 'none');
    assert.equal(resolvedReview.snapshot.composition.parts.some(part => part.role === 'review-json-retry'), false);
    const resolvedConflict = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'conflict', executionId: 'opaque-conflict' });
    assert.equal(resolvedConflict.snapshot.composition.parts.some(part => ['submit_conflict_proposal', 'repair-completion'].some(token => part.content.includes(token))), false);
    const resolvedCi = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'ci', executionId: 'opaque-ci' });
    assert.equal(resolvedCi.permission, 'read_write_approval');
    assert.equal(resolvedCi.snapshot.composition.parts.some(part => ['request_repair_verification', 'repair-completion'].some(token => part.content.includes(token))), false);
    const resolvedConversation = await resolveExecution(db, { kind: 'conversation', repositoryId: repository.id, executionId: 'opaque-conversation' });
    assert.equal(resolvedConversation.outputContract.kind, 'human_markdown');
    assert.equal(resolvedConversation.snapshot.composition.parts.find(part => part.role === 'conversation')?.content, loadOperation('conversation'));
  } finally { closeControlPlaneDb(db); }
});

test('opaque-output migration converges the approval-aware review plan-mode tail', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const publicLegacy = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review-json-retry')!;
    const repositoryLegacy = await copyPublicPrompt(db, repository.id, publicLegacy.id);
    const prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const promptByRole = new Map(prompts.map(asset => [asset.role ?? asset.slug, asset]));
    promptByRole.set('review-json-retry', repositoryLegacy);
    const review = (await getCommandByName(db, repository.id, 'review'))!;
    await writeHistoricalCommandBindings(db, review.id, [
      { assetId: promptByRole.get('review')!.id, bindingKind: 'main' },
      { assetId: promptByRole.get('review-json-retry')!.id, bindingKind: 'auxiliary' },
      { assetId: promptByRole.get('stop-closeout')!.id, bindingKind: 'auxiliary' },
      { assetId: promptByRole.get('shared')!.id, bindingKind: 'common' },
      { assetId: promptByRole.get('plan-mode')!.id, bindingKind: 'auxiliary' },
    ], 'read_write_approval');

    const reports = await runBuiltinAssetMigrations(db, { only: ['builtin-assets-v2-opaque-output'] });
    const opaque = reports.find(report => report.migrationId === 'builtin-assets-v2-opaque-output')!;
    assert.ok(opaque.actions.some(action => action.action === 'command_layout_converged'
      && action.detail === 'review_v1_json_retry_with_plan_mode_tail → review_current_read_write_approval'));

    const after = (await getCommandByName(db, repository.id, 'review'))!;
    const afterPrompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    assert.equal(after.permission, 'read_write_approval');
    assert.deepEqual(after.promptBindings.map(binding => afterPrompts.find(asset => asset.id === binding.assetId)?.role), [
      'review', 'stop-closeout', 'plan-mode', 'shared',
    ]);

    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'review', executionId: 'approval-review-tail' });
    assert.equal(resolved.permission, 'read_write_approval');
    assert.equal(resolved.outputContract.kind, 'none');
    assert.equal(resolved.snapshot.composition.parts.some(part => part.role === 'review-json-retry'), false);
  } finally { closeControlPlaneDb(db); }
});

test('opaque-output migration preserves an unknown operator Prompt override', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const review = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review')!;
    const custom = '我自己的中文审查格式\n不要求固定字段。';
    await updatePrompt(db, review.id, { content: custom }, { expectedRevision: review.revision });
    const repositoryReview = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === 'review')!;
    await updatePrompt(db, repositoryReview.id, { content: custom }, { expectedRevision: repositoryReview.revision });
    const reports = await runBuiltinAssetMigrations(db);
    const after = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review')!;
    const afterRepository = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === 'review')!;
    assert.equal(after.content, custom);
    assert.equal(afterRepository.content, custom);
    assert.equal((await findMarker(db, null, 'public-prompt:review'))?.state, 'override');
    assert.equal((await findMarker(db, repository.id, 'prompt:review'))?.state, 'override');
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v2-opaque-output')?.actions.some(action => action.action === 'preserved_override'));
    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'review', executionId: 'opaque-override' });
    assert.equal(resolved.outputContract.kind, 'none');
  } finally { closeControlPlaneDb(db); }
});

test('opaque-output migration keeps read_write CI layouts without plan-mode', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const promptByRole = new Map(prompts.map(asset => [asset.role ?? asset.slug, asset]));
    const ci = (await getCommandByName(db, repository.id, 'ci'))!;
    const legacyRoles = ['repair-completion', 'repair-feedback', 'repair-no-verification', 'repair-verification-empty', 'repair-closeout', 'stop-closeout'];
    await updateCommand(db, ci.id, {
      permission: 'read_write',
      promptBindings: [
        { assetId: promptByRole.get('ci-repair')!.id, position: 1, enabled: true, bindingKind: 'main' },
        ...legacyRoles.map((role, index) => ({ assetId: promptByRole.get(role)!.id, position: index + 2, enabled: true, bindingKind: 'auxiliary' as const })),
        { assetId: promptByRole.get('shared')!.id, position: legacyRoles.length + 2, enabled: true, bindingKind: 'common' },
      ],
    }, { expectedRevision: ci.revision });

    await runBuiltinAssetMigrations(db);

    const after = (await getCommandByName(db, repository.id, 'ci'))!;
    assert.equal(after.permission, 'read_write');
    assert.deepEqual(after.promptBindings.map(binding => prompts.find(asset => asset.id === binding.assetId)?.role), ['ci-repair', 'repair-closeout', 'stop-closeout', 'shared']);
    assert.equal(after.promptBindings.some(binding => prompts.find(asset => asset.id === binding.assetId)?.role === 'plan-mode'), false);
    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'ci', executionId: 'opaque-ci-read-write' });
    assert.equal(resolved.permission, 'read_write');
  } finally { closeControlPlaneDb(db); }
});

test('opaque-output migration preserves an unknown operator command layout', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const custom = await createPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'review-extra', title: 'Review extra', role: null, content: 'operator-owned composition' });
    const review = (await getCommandByName(db, repository.id, 'review'))!;
    const before = await updateCommand(db, review.id, {
      promptBindings: [...review.promptBindings, { assetId: custom.id, position: 4, enabled: true, bindingKind: 'auxiliary' }],
    }, { expectedRevision: review.revision });

    await runBuiltinAssetMigrations(db);

    const after = (await getCommandByName(db, repository.id, 'review'))!;
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.promptBindings, before.promptBindings);
    assert.equal((await findMarker(db, repository.id, 'command:review'))?.state, 'override');
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration is idempotent and does not churn revisions or content', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    await runBuiltinAssetMigrations(db);
    const snapshot = async () => {
      const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
      const repoPlan = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === 'plan-mode')!;
      const conflict = (await getCommandByName(db, repository.id, 'conflict'))!;
      const managed = (await getRepositoryByName(db, 'owner/lab'))!;
      return { publicRevision: publicPlan.revision, publicContent: publicPlan.content, repoRevision: repoPlan.revision,
        conflictRevision: conflict.revision, bindingCount: conflict.promptBindings.length, repositoryRevision: managed.revision };
    };
    const before = await snapshot();

    assert.deepEqual(await runBuiltinAssetMigrations(db), [], 'a recorded migration is not re-applied');
    assert.deepEqual(await snapshot(), before);

    await runBuiltinAssetMigrations(db, { force: true });
    assert.deepEqual(await snapshot(), before, 're-applying the migration is still a no-op');

    assert.equal((await listPrompts(db, { scope: 'public' })).filter(asset => asset.slug === 'plan-mode').length, 1);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).filter(asset => asset.slug === 'plan-mode').length, 1);
    assert.equal((await listBuiltinAssetMigrations(db)).length, 2);
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration preserves an operator override byte-for-byte', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const custom = 'CUSTOM PLAN PROMPT\nDo not touch.\n';
    const override = await createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'My Plan', role: 'plan-mode', content: custom });
    const reports = await runBuiltinAssetMigrations(db);

    const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    assert.equal(publicPlan.id, override.id);
    assert.equal(publicPlan.content, custom);
    assert.equal(publicPlan.title, 'My Plan');
    assert.equal(publicPlan.enabled, true);
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'override');
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.scope === 'public' && action.action === 'preserved_override'));
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration does not re-enable a disabled public asset and fails safe for /conflict', async () => {
  const { db } = await oldRuntimeDb();
  try {
    await createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Plan', role: 'plan-mode', content: 'DISABLED PLAN', enabled: false });
    const reports = await runBuiltinAssetMigrations(db);

    const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    assert.equal(publicPlan.enabled, false);
    assert.equal(publicPlan.content, 'DISABLED PLAN');
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'disabled');
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.scope === 'public' && action.action === 'preserved_disabled'));

    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const conflict = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(conflict.permission, 'read_write', 'an unavailable plan-mode must not break the seeded command');
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).some(asset => asset.slug === 'plan-mode'), false);
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration does not resurrect a tombstoned public asset', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const created = await createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Plan', role: 'plan-mode', content: 'OLD PLAN' });
    await deletePrompt(db, created.id, { expectedRevision: created.revision });
    const reports = await runBuiltinAssetMigrations(db);

    assert.equal((await listPrompts(db, { scope: 'public' })).some(asset => asset.slug === 'plan-mode'), false);
    assert.equal((await findMarker(db, null, 'public-prompt:plan-mode'))?.state, 'tombstone');
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.scope === 'public' && action.action === 'preserved_tombstone'));
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration fails closed on a malformed ownership identity', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const created = await createPrompt(db, { scope: 'public', slug: 'plan-mode', title: 'Plan', role: 'plan-mode', content: 'UNOWNED PLAN' });
    await db.execute(`DELETE FROM bootstrap_markers WHERE repository_id IS NULL AND seed_key = 'public-prompt:plan-mode'`);
    await assert.rejects(runBuiltinAssetMigrations(db), error => (error as { code?: string }).code === 'invalid_configuration');

    const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    assert.equal(publicPlan.id, created.id);
    assert.equal(publicPlan.content, 'UNOWNED PLAN');
    assert.equal((await listBuiltinAssetMigrations(db)).length, 0, 'a conflict records nothing and changes nothing');
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration refuses a public role collision instead of overwriting', async () => {
  const { db } = await oldRuntimeDb();
  try {
    await insertMalformedPrompt(db, { scope: 'public', slug: 'my-plan', role: 'plan-mode', content: 'OTHER PLAN' });
    await assert.rejects(runBuiltinAssetMigrations(db), /already held by "my-plan"/);
    assert.equal((await listPrompts(db, { scope: 'public' })).some(asset => asset.slug === 'plan-mode'), false);
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration leaves an operator-owned /conflict command untouched', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const before = (await getCommandByName(db, repository.id, 'conflict'))!;
    await db.execute(`UPDATE bootstrap_markers SET state = 'override', source_digest = 'manual'
      WHERE repository_id = :id AND seed_key = 'command:conflict'`, { id: repository.id });

    const reports = await runBuiltinAssetMigrations(db);
    const after = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(after.permission, 'read_write');
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.promptBindings, before.promptBindings);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).some(asset => asset.slug === 'plan-mode'), false,
      'an operator-owned command must not pull in a repository plan-mode copy');
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.kind === 'command' && action.action === 'preserved_override'));
  } finally { closeControlPlaneDb(db); }
});

test('builtin migration never auto-binds a custom command; quick-add stays explicit', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const modelId = (await getCommandByName(db, repository.id, 'review'))!.providerModelId;
    const main = await createPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'custom-main', title: 'Custom', role: null, content: 'CUSTOM TASK' });
    const custom = await createCommand(db, { repositoryId: repository.id, slashName: 'deploy', displayName: 'Deploy', executionType: 'custom',
      permission: 'read_write_approval', providerModelId: modelId,
      promptBindings: [{ assetId: main.id, position: 1, enabled: true, bindingKind: 'main' }], skillBindings: [] });

    await runBuiltinAssetMigrations(db);
    const afterMigration = (await getCommandByName(db, repository.id, 'deploy'))!;
    assert.equal(afterMigration.permission, 'read_write_approval');
    assert.deepEqual(afterMigration.promptBindings, custom.promptBindings, 'migration must not touch a custom command');

    // Quick-add: reuse the repository copy installed for the built-in /conflict.
    const repoPlan = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.role === 'plan-mode')!;
    const bound = await updateCommand(db, afterMigration.id, { promptBindings: [...afterMigration.promptBindings,
      { assetId: repoPlan.id, position: 2, enabled: true, bindingKind: 'auxiliary' }] }, { expectedRevision: afterMigration.revision });
    assert.equal(bound.promptBindings.some(binding => binding.assetId === repoPlan.id), true);
    const resolved = await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'deploy', executionId: 'e2' });
    assert.equal(resolved.permission, 'read_write_approval');
  } finally { closeControlPlaneDb(db); }
});

test('quick-add can copy the public plan-mode asset when a repository has no copy', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const modelId = (await getCommandByName(db, repository.id, 'review'))!.providerModelId;
    const main = await createPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'custom-main', title: 'Custom', role: null, content: 'CUSTOM TASK' });
    await createCommand(db, { repositoryId: repository.id, slashName: 'deploy', displayName: 'Deploy', executionType: 'custom',
      permission: 'read_write_approval', providerModelId: modelId,
      promptBindings: [{ assetId: main.id, position: 1, enabled: true, bindingKind: 'main' }], skillBindings: [] });
    // Make the built-in /conflict operator-owned so the migration installs no repository copy.
    await db.execute(`UPDATE bootstrap_markers SET state = 'override', source_digest = 'manual'
      WHERE repository_id = :id AND seed_key = 'command:conflict'`, { id: repository.id });
    await runBuiltinAssetMigrations(db);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).some(asset => asset.slug === 'plan-mode'), false);

    const publicPlan = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    const copied = await copyPublicPrompt(db, repository.id, publicPlan.id);
    assert.equal(copied.role, 'plan-mode');
    assert.equal((await findMarker(db, repository.id, 'prompt:plan-mode'))?.state, 'seeded');

    const custom = (await getCommandByName(db, repository.id, 'deploy'))!;
    const bound = await updateCommand(db, custom.id, { promptBindings: [...custom.promptBindings,
      { assetId: copied.id, position: 2, enabled: true, bindingKind: 'auxiliary' }] }, { expectedRevision: custom.revision });
    assert.equal(bound.promptBindings.some(binding => binding.assetId === copied.id), true);
    await resolveExecution(db, { kind: 'command', repositoryId: repository.id, slashName: 'deploy', executionId: 'e3' });
  } finally { closeControlPlaneDb(db); }
});

test('public override with a malformed builtin identity fails closed', async () => {
  const { db } = await oldRuntimeDb();
  try {
    await insertMalformedPrompt(db, { scope: 'public', slug: 'plan-mode', role: 'other-role', content: 'MALFORMED PLAN' });
    const reviewBefore = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review')!.content;

    await assert.rejects(runBuiltinAssetMigrations(db), error => (error as { code?: string }).code === 'invalid_configuration');

    assert.equal((await listBuiltinAssetMigrations(db)).length, 0, 'a conflict records nothing');
    const malformed = (await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'plan-mode')!;
    assert.equal(malformed.role, 'other-role');
    assert.equal(malformed.content, 'MALFORMED PLAN', 'the malformed asset is never overwritten');
    assert.equal((await listPrompts(db, { scope: 'public' })).find(asset => asset.slug === 'review')!.content, reviewBefore,
      'unrelated content is untouched');
  } finally { closeControlPlaneDb(db); }
});

test('repository override with a malformed builtin identity fails closed without partial migration', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    await insertMalformedPrompt(db, { scope: 'repository', repositoryId: repository.id, slug: 'plan-mode', role: 'other-role', content: 'MALFORMED REPO PLAN' });
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;

    await assert.rejects(runBuiltinAssetMigrations(db), error => (error as { code?: string }).code === 'invalid_configuration');

    assert.equal((await listBuiltinAssetMigrations(db)).length, 0);
    assert.equal((await listPrompts(db, { scope: 'public' })).some(asset => asset.slug === 'plan-mode'), false,
      'public creation rolls back with the failed transaction');
    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(afterCommand.permission, beforeCommand.permission);
    assert.deepEqual(afterCommand.promptBindings, beforeCommand.promptBindings);
    assert.equal((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.slug === 'plan-mode')!.role, 'other-role');
  } finally { closeControlPlaneDb(db); }
});

test('permission-only convergence keeps command revision, marker and repository revision coherent', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    await db.execute(`UPDATE commands SET permission = 'read_write' WHERE slash_name = 'conflict'`);
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const beforeRepository = (await getRepositoryByName(db, 'owner/lab'))!;

    const reports = await runBuiltinAssetMigrations(db);

    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const afterRepository = (await getRepositoryByName(db, 'owner/lab'))!;
    const afterMarker = (await findMarker(db, repository.id, 'command:conflict'))!;
    assert.equal(afterCommand.permission, 'read_write_approval');
    assert.equal(afterCommand.revision, beforeCommand.revision + 1);
    assert.equal(afterRepository.revision, beforeRepository.revision + 1);
    assert.equal(afterMarker.sourceRevision, afterCommand.revision, 'marker tracks the actual final revision');
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.kind === 'command' && action.action === 'command_permission_converged'));
    assert.equal(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.kind === 'binding' && action.action === 'binding_added'), false,
      'an already-active binding is not re-added');
  } finally { closeControlPlaneDb(db); }
});

test('binding-only convergence writes the final revision and digest', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    await db.execute(`DELETE FROM command_prompts WHERE prompt_asset_id IN (SELECT id FROM prompt_assets WHERE slug = 'plan-mode')`);
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const beforeRepository = (await getRepositoryByName(db, 'owner/lab'))!;

    await runBuiltinAssetMigrations(db);

    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const afterRepository = (await getRepositoryByName(db, 'owner/lab'))!;
    const afterMarker = (await findMarker(db, repository.id, 'command:conflict'))!;
    const planMode = (await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).find(asset => asset.role === 'plan-mode')!;
    const boundIds = (await db.execute('SELECT prompt_asset_id FROM command_prompts WHERE command_id = :id ORDER BY position', { id: afterCommand.id }))
      .rows.map(row => String(row.prompt_asset_id));
    assert.equal(afterCommand.revision, beforeCommand.revision + 1);
    assert.equal(afterRepository.revision, beforeRepository.revision + 1);
    assert.equal(afterMarker.sourceRevision, afterCommand.revision);
    assert.equal(afterMarker.sourceDigest, contentDigest(boundIds.join(':')));
    assert.equal(afterCommand.promptBindings.some(binding => binding.assetId === planMode.id && binding.enabled), true);
  } finally { closeControlPlaneDb(db); }
});

test('permission and binding convergence records the actual final command revision', async () => {
  const { db } = await oldRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const beforeRepository = (await getRepositoryByName(db, 'owner/lab'))!;

    await runBuiltinAssetMigrations(db);

    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const afterRepository = (await getRepositoryByName(db, 'owner/lab'))!;
    const afterMarker = (await findMarker(db, repository.id, 'command:conflict'))!;
    assert.equal(afterCommand.permission, 'read_write_approval');
    assert.equal(afterCommand.revision, beforeCommand.revision + 1, 'one convergence run bumps the command once');
    assert.equal(afterRepository.revision, beforeRepository.revision + 2, 'copy creation and command convergence each bump the repository');
    assert.equal(afterMarker.sourceRevision, afterCommand.revision);
  } finally { closeControlPlaneDb(db); }
});

test('an already-correct seeded /conflict produces no revision churn', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const beforeRepository = (await getRepositoryByName(db, 'owner/lab'))!;
    const beforeMarker = (await findMarker(db, repository.id, 'command:conflict'))!;

    const reports = await runBuiltinAssetMigrations(db);

    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    const afterRepository = (await getRepositoryByName(db, 'owner/lab'))!;
    const afterMarker = (await findMarker(db, repository.id, 'command:conflict'))!;
    assert.equal(afterCommand.revision, beforeCommand.revision);
    assert.equal(afterRepository.revision, beforeRepository.revision);
    assert.equal(afterMarker.sourceRevision, beforeMarker.sourceRevision);
    assert.equal(afterMarker.sourceDigest, beforeMarker.sourceDigest);
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.kind === 'binding' && action.action === 'binding_present'));
  } finally { closeControlPlaneDb(db); }
});

test('a disabled plan-mode binding is not treated as satisfied', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    await db.execute(`UPDATE command_prompts SET enabled = 0 WHERE prompt_asset_id IN (SELECT id FROM prompt_assets WHERE slug = 'plan-mode')`);
    await db.execute(`UPDATE commands SET permission = 'read_write' WHERE slash_name = 'conflict'`);
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;

    const reports = await runBuiltinAssetMigrations(db);

    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(afterCommand.permission, 'read_write', 'do not converge into a state the resolver rejects');
    assert.equal(afterCommand.revision, beforeCommand.revision);
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.action === 'skipped' && action.detail === 'inactive plan-mode binding preserved'));
  } finally { closeControlPlaneDb(db); }
});

test('a disabled repository plan-mode asset is not treated as active', async () => {
  const { db } = await freshRuntimeDb();
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    await db.execute(`UPDATE prompt_assets SET enabled = 0 WHERE scope = 'repository' AND slug = 'plan-mode'`);
    const beforeCommand = (await getCommandByName(db, repository.id, 'conflict'))!;

    const reports = await runBuiltinAssetMigrations(db);

    const afterCommand = (await getCommandByName(db, repository.id, 'conflict'))!;
    assert.equal(afterCommand.revision, beforeCommand.revision);
    assert.ok(reports.find(report => report.migrationId === 'builtin-assets-v1-plan-mode')!.actions.some(action => action.kind === 'command' && action.action === 'skipped'));
  } finally { closeControlPlaneDb(db); }
});

