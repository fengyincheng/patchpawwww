import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryProvider, ProviderUnavailable, isTransient } from '../src/harness/retry.ts';

test('provider retries the same call, honors Retry-After, and preserves caller state', async () => {
  const state = { edits: 1, calls: 0 };
  const delays: number[] = [];
  const result = await retryProvider(async () => {
    state.calls++;
    if (state.calls < 3) throw Object.assign(new Error('temporary'), { status: 503, retryAfter: '2' });
    return state.edits;
  }, { sleep: async ms => { delays.push(ms); }, jitter: () => 0 });
  assert.equal(result, 1);
  assert.deepEqual(delays, [2000, 2000]);
  assert.equal(state.calls, 3);
  await assert.rejects(retryProvider(async () => { throw Object.assign(new Error('auth'), { status: 401 }); }), /auth/);
  assert.equal(isTransient(Object.assign(new Error('fetch failed'), { status: 401 })), false);
  await assert.rejects(retryProvider(async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); },
    { sleep: async () => {} }), ProviderUnavailable);
});
