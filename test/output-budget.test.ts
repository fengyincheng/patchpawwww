import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputBudget, applyOutputBudget } from '../src/models/output-budget.ts';

test('output budget defaults to 60000 when capability is unknown', () => {
  const resolved = resolveOutputBudget({});
  assert.deepEqual(resolved, { requested: 60_000, effective: 60_000, source: 'default', wireKey: 'max_tokens' });
  const body: Record<string, unknown> = { max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3 };
  applyOutputBudget(body, resolved);
  assert.deepEqual(body, { max_tokens: 60_000 });
});

test('known lower model capability clamps the effective budget without guessing it', () => {
  const resolved = resolveOutputBudget({}, 4096);
  assert.equal(resolved.requested, 60_000);
  assert.equal(resolved.effective, 4096);
  assert.equal(resolved.capability, 4096);
});

test('explicit provider output options have one deterministic wire field', () => {
  assert.equal(resolveOutputBudget({ max_tokens: 2048 }).effective, 2048);
  assert.deepEqual(resolveOutputBudget({ max_completion_tokens: 1024 }), {
    requested: 1024, effective: 1024, source: 'max_completion_tokens', wireKey: 'max_completion_tokens',
  });
  assert.equal(resolveOutputBudget({ max_output_tokens: 512 }).wireKey, 'max_tokens');
  assert.throws(() => resolveOutputBudget({ max_tokens: 1, max_completion_tokens: 2 }), /only one output token limit/);
});
