export type AgentTurnPhase = 'execution' | 'final_answer' | 'closeout' | 'stop';

export interface AgentTurnFacts {
  text: string;
  finishReason?: string;
  stepCount: number;
  maxSteps: number;
  deadlineExpired: boolean;
  lastStepHadToolCall: boolean;
}

export type AgentTurnCompletion =
  | { kind: 'completed' }
  | { kind: 'final_answer_required'; reason: 'deadline' | 'step_budget' }
  | { kind: 'protocol_failure' };

export function evaluateAgentTurnCompletion(facts: AgentTurnFacts): AgentTurnCompletion {
  if (facts.text.trim()) return { kind: 'completed' };
  if (facts.deadlineExpired) return { kind: 'final_answer_required', reason: 'deadline' };
  if (facts.stepCount >= facts.maxSteps && facts.lastStepHadToolCall) {
    return { kind: 'final_answer_required', reason: 'step_budget' };
  }
  return { kind: 'protocol_failure' };
}

export type FinalAnswerCapability = 'text_only' | 'conversation_reply';

const CONVERSATION_REPLY_TOOLS = ['reply_to_pr'] as const;

/** Runtime-owned capabilities; callers cannot add arbitrary workspace or command tools. */
export function finalAnswerTools(capability: FinalAnswerCapability | undefined): readonly string[] {
  return capability === 'conversation_reply' ? CONVERSATION_REPLY_TOOLS : [];
}

export function convergenceInstruction(customGuidance: string | undefined, remaining: number, critical: boolean) {
  if (customGuidance?.trim()) return customGuidance;
  const urgency = critical ? '执行预算即将耗尽' : '执行预算正在接近上限';
  return `${urgency}。停止开始新的大范围调查或工具循环，开始根据现有证据收敛最终答复。当前剩余 ${remaining} 个执行步骤。`;
}

export function finalAnswerInstruction(task: string, capability: FinalAnswerCapability | undefined) {
  const capabilityInstruction = capability === 'conversation_reply'
    ? '如需发布对话答复，只允许使用保留的 reply_to_pr 能力。'
    : '不要调用工具，只返回最终自然语言答复。';
  return `普通 ${task} 执行预算已结束。现在停止探索并立即收敛。只使用当前会话中已经获得的证据，不要开始新的调查、编辑或命令循环。${capabilityInstruction}答复必须保持为原样自然语言文本，不要转成结构化协议。`;
}
