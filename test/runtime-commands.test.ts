import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapControlPlane,
  closeControlPlaneDb,
  createCommand,
  createPrompt,
  getCommandByName,
  getRepositoryByName,
  listPrompts,
  listSkills,
  openControlPlaneDb,
  resolveExecution,
  updateCommand,
  updatePrompt,
} from '../src/control-plane/index.ts';
import { parsePRIntent } from '../src/runner/command.ts';
import { renderRuntimePrompt, runtimeExecutionFromSnapshot } from '../src/harness/runtime.ts';
import { runPullRequest } from '../src/runner/pull-request.ts';
import { fixture as prFixture } from './helpers/pr-fixture.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-runtime-commands-'));
  const report = await bootstrapControlPlane({ root, env: { ZAI_MODEL: 'glm-runtime-command-test' }, repositories: [{ fullName: 'Owner/Repo' }] });
  const db = await openControlPlaneDb(root);
  const repository = (await getRepositoryByName(db, 'owner/repo'))!;
  return { root, db, report, repository };
}

test('intent parsing resolves the live command registry and keeps controls safe', async () => {
  const { root, db, report, repository } = await fixture();
  try {
    const prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const skills = await listSkills(db, { scope: 'repository', repositoryId: repository.id });
    const review = prompts.find(value => value.role === 'review')!;
    const retry = prompts.find(value => value.role === 'review-json-retry')!;
    const shared = prompts.find(value => value.role === 'shared')!;
    const help = skills.find(value => value.slug === 'patchpaw-human-help')!;
    const custom = await createCommand(db, {
      repositoryId: repository.id,
      slashName: '/Fix-It',
      displayName: 'Fix it',
      executionType: 'review',
      permission: 'read_only',
      providerModelId: report.model.id,
      promptBindings: [
        { assetId: review.id, position: 1, enabled: true, bindingKind: 'main' },
        { assetId: shared.id, position: 2, enabled: true, bindingKind: 'common' },
        { assetId: retry.id, position: 3, enabled: true, bindingKind: 'auxiliary' },
      ],
      skillBindings: [{ assetId: help.id, position: 1, enabled: true }],
    });

    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /FIX-IT', 'patchpawwww'), {
      kind: 'command', commandId: custom.id, slashName: 'fix-it', executionType: 'review', permission: 'read_only',
    });
    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /confict', 'patchpawwww'), {
      kind: 'command', commandId: (await getCommandByName(db, repository.id, '/conflict'))!.id,
      slashName: 'conflict', executionType: 'conflict', permission: 'read_write',
    });
    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /approval', 'patchpawwww'), { kind: 'control', control: 'approval' });
    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /APPROVE', 'patchpawwww'), { kind: 'control', control: 'approval' });
    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /does-not-exist', 'patchpawwww'), {
      kind: 'conversation', repositoryId: repository.id, reason: 'unknown_command',
    });
    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /FIX-IT /CI', 'patchpawwww'), {
      kind: 'conversation', repositoryId: repository.id, reason: 'ambiguous_command',
    });
    assert.deepEqual(await parsePRIntent(db, repository.id, '```\n@patchpawwww /FIX-IT\n```', 'patchpawwww'), {
      kind: 'conversation', repositoryId: repository.id, reason: 'plain_mention',
    });

    await updateCommand(db, custom.id, { enabled: false }, { expectedRevision: custom.revision });
    assert.deepEqual(await parsePRIntent(db, repository.id, '@patchpawwww /fix-it', 'patchpawwww'), {
      kind: 'conversation', repositoryId: repository.id, reason: 'disabled_command',
    });
  } finally {
    closeControlPlaneDb(db);
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime prompt rendering stays on the immutable snapshot after control-plane edits', async () => {
  const { root, db, repository } = await fixture();
  try {
    const first = await resolveExecution(db, { kind: 'conversation', repositoryId: repository.id, executionId: 'run-1:1' });
    assert.equal(first.snapshot.output_budget?.effective, 60_000);
    const execution = runtimeExecutionFromSnapshot(first.snapshot, root, { ZAI_API_KEY: 'fixture-secret' });
    const legacyCompatible = structuredClone(first.snapshot) as typeof first.snapshot;
    delete legacyCompatible.output_budget;
    assert.equal(runtimeExecutionFromSnapshot(legacyCompatible, root).outputBudget.effective, 60_000);
    const original = renderRuntimePrompt({ execution }, 'conversation', { comment: 'hello' });
    const main = first.prompts.find(value => value.role === 'conversation')!;
    await updatePrompt(db, main.id, { content: `${main.content}\nNew live behavior.` }, { expectedRevision: main.revision });
    const second = await resolveExecution(db, { kind: 'conversation', repositoryId: repository.id, executionId: 'run-2:1' });
    const current = renderRuntimePrompt({ execution: runtimeExecutionFromSnapshot(second.snapshot, root) }, 'conversation', { comment: 'hello' });

    assert.equal(execution.modelSelection.model.identifier, 'glm-runtime-command-test');
    assert.notEqual(current, original);
    assert.equal(renderRuntimePrompt({ execution }, 'conversation', { comment: 'hello' }), original);
    assert.equal(original.includes('New live behavior.'), false);
  } finally {
    closeControlPlaneDb(db);
    await rm(root, { recursive: true, force: true });
  }
});

test('runner executes a configured repair command with its snapshot model and Prompt stack', async t => {
  const f = await prFixture(t, false);
  await bootstrapControlPlane({ root: f.root, env: { ZAI_MODEL: 'glm-runtime-command-test', ZAI_BASE_URL: 'https://model.fixture/v1' }, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(f.root);
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const prompts = await listPrompts(db, { scope: 'repository', repositoryId: repository.id });
    const skills = await listSkills(db, { scope: 'repository', repositoryId: repository.id });
    const completion = prompts.find(value => value.role === 'repair-completion')!;
    await updatePrompt(db, completion.id, { content: `${completion.content}\nCUSTOM_RUNTIME_COMMAND_MARKER` }, { expectedRevision: completion.revision });
    const shared = prompts.find(value => value.role === 'shared')!;
    const feedback = prompts.find(value => value.role === 'repair-feedback')!;
    const noVerification = prompts.find(value => value.role === 'repair-no-verification')!;
    const empty = prompts.find(value => value.role === 'repair-verification-empty')!;
    const help = skills.find(value => value.slug === 'patchpaw-human-help')!;
    await createCommand(db, {
      repositoryId: repository.id,
      slashName: '/Fix-It',
      displayName: 'Fix it',
      executionType: 'repair',
      permission: 'read_write',
      providerModelId: (await getCommandByName(db, repository.id, '/ci'))!.providerModelId,
      promptBindings: [
        { assetId: completion.id, position: 1, enabled: true, bindingKind: 'main' },
        { assetId: shared.id, position: 2, enabled: true, bindingKind: 'common' },
        { assetId: feedback.id, position: 3, enabled: true, bindingKind: 'auxiliary' },
        { assetId: noVerification.id, position: 4, enabled: true, bindingKind: 'auxiliary' },
        { assetId: empty.id, position: 5, enabled: true, bindingKind: 'auxiliary' },
      ],
      skillBindings: [{ assetId: help.id, position: 1, enabled: true }],
    });
  } finally {
    closeControlPlaneDb(db);
  }
  f.control.turn = 1;
  await f.mention('@patchpawwww /fix-it');
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'repair_completed');
  assert.equal(f.modelInputs[0].model, 'glm-runtime-command-test');
  assert.match(JSON.stringify(f.modelInputs[0].messages), /CUSTOM_RUNTIME_COMMAND_MARKER/);
  assert.equal(f.calls.some(call => call.path.endsWith('/pulls/7/reviews')), false);
  const manifest = JSON.parse(await readFile(join(f.root, 'runs', result.run_id!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.command, 'fix-it');
  assert.equal(typeof manifest.snapshot_sha256, 'string');
  assert.equal(typeof manifest.snapshot_path, 'string');
});

test('runner executes a custom command from only its selected Prompt stack and publishes natural language', async t => {
  const f = await prFixture(t, false);
  await bootstrapControlPlane({ root: f.root, env: { ZAI_MODEL: 'glm-runtime-command-test', ZAI_BASE_URL: 'https://model.fixture/v1' }, repositories: [{ fullName: 'owner/lab' }] });
  const db = await openControlPlaneDb(f.root);
  try {
    const repository = (await getRepositoryByName(db, 'owner/lab'))!;
    const prompt = await createPrompt(db, {
      scope: 'repository', repositoryId: repository.id, slug: 'readme-task', title: 'README task', role: null,
      content: 'CUSTOM_TASK_MARKER\nRead the requested README and answer in natural language.',
    });
    await createCommand(db, {
      repositoryId: repository.id, slashName: '/readme', displayName: 'README', description: 'Read README',
      executionType: 'custom', permission: 'read_only', providerModelId: (await getCommandByName(db, repository.id, '/review'))!.providerModelId,
      promptBindings: [{ assetId: prompt.id, position: 1, enabled: true, bindingKind: 'main' }], skillBindings: [],
    });
  } finally {
    closeControlPlaneDb(db);
  }

  await f.mention('@patchpawwww /readme');
  const result = await runPullRequest(f.config, 'owner/lab', 7);
  assert.equal(result.status, 'custom_completed');
  assert.equal(f.publishedReviews.length, 0);
  assert.equal(f.publishedComments.length, 1);
  assert.match(f.publishedComments[0].body, /CUSTOM_NATURAL_LANGUAGE_ANSWER/);
  const messages = JSON.stringify(f.modelInputs[0].messages);
  assert.match(messages, /CUSTOM_TASK_MARKER/);
  assert.doesNotMatch(messages, /Prompt review|review-json-retry|Conflict Proposal|CI repair/);
  const toolNames = f.modelInputs[0].tools.map((tool: any) => tool.function.name);
  assert.equal(toolNames.includes('mastra_workspace_edit_file'), false);
  assert.equal(toolNames.includes('mastra_workspace_execute_command'), false);
});
