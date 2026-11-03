import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAgentTurnCompletion, type AgentTurnFacts } from '../src/harness/agent-turn-lifecycle.ts';

function facts(overrides: Partial<AgentTurnFacts> = {}): AgentTurnFacts {
  return {
    text: 'working narration',
    finalText: '',
    stepCount: 1,
    maxSteps: 1,
    deadlineExpired: false,
    lastStepHadToolCall: true,
    ...overrides,
  };
}

test('legacy completion keeps the concatenated-text contract', () => {
  assert.deepEqual(evaluateAgentTurnCompletion(facts(), false), { kind: 'completed' });
});

test('opaque completion requires a tool-free final step and reserves a final-answer phase', () => {
  assert.deepEqual(evaluateAgentTurnCompletion(facts(), true), { kind: 'final_answer_required', reason: 'step_budget' });
  assert.deepEqual(evaluateAgentTurnCompletion(facts({ text: '' }), true), { kind: 'final_answer_required', reason: 'step_budget' });
  assert.deepEqual(evaluateAgentTurnCompletion(facts({ finalText: 'final answer', lastStepHadToolCall: false }), true), { kind: 'completed' });
  assert.deepEqual(evaluateAgentTurnCompletion(facts({ text: '', stepCount: 0, lastStepHadToolCall: false }), true), { kind: 'protocol_failure' });
  assert.deepEqual(evaluateAgentTurnCompletion(facts({ text: '', deadlineExpired: true }), true), { kind: 'final_answer_required', reason: 'deadline' });
});
