import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeOperations, loadOperation, renderOperation } from '../src/operation/load.ts';
import { conflictPrompt } from '../src/tasks/conflict/prompt.ts';
import { ciRepairPrompt } from '../src/tasks/ci-repair/prompt.ts';
import { reviewPrompt } from '../src/tasks/review/prompt.ts';
import { conversationPrompt } from '../src/tasks/conversation/prompt.ts';

test('required operation assets load and compose shared repair behavior', () => {
  for (const name of ['shared', 'conversation', 'conflict', 'ci-repair', 'review', 'repair-completion',
    'repair-feedback', 'repair-closeout', 'stop-closeout', 'review-json-retry']) {
    assert.ok(loadOperation(name).length, name);
  }
  assert.equal(conflictPrompt.includes('真实合并'), true);
  assert.equal(conflictPrompt.includes('submit_conflict_proposal'), true);
  assert.equal(ciRepairPrompt.includes('read_ci_evidence'), true);
  assert.equal(ciRepairPrompt.includes('request_repair_verification'), true);
  assert.equal(reviewPrompt.includes('只读 /review 任务'), true);
  assert.equal(reviewPrompt.includes('只返回 JSON'), true);
  assert.equal(reviewPrompt.includes('"recommendation"'), true);
  assert.equal(conversationPrompt.includes('reply_to_pr'), true);
  assert.equal(conversationPrompt.includes('不要启动修复或评审'), true);
  assert.equal(composeOperations('conflict', 'repair-completion').includes('只提交一份结构化冲突提案'), true);
  assert.equal(composeOperations('conflict', 'repair-completion').includes('git add'), false);
});

test('operation rendering interpolates explicit values and fails clearly', () => {
  assert.equal(renderOperation('repair-feedback', { evidence: 'failure: test' }),
    '独立验证失败。在同一工作区与同一线程中继续，然后再次请求验证。实际证据：failure: test');
  assert.throws(() => renderOperation('repair-feedback', {}), /Missing value/);
  assert.throws(() => renderOperation('missing-required-asset', {}), /Required operation asset is missing/);
  assert.throws(() => renderOperation('repair-feedback', { evidence: 'x', extra: 'y' }), /Unused operation values/);
});
