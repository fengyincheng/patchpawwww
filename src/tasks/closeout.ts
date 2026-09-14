import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { git } from '../workspace/git.ts';
import { readArtifact } from '../runner/review-lifecycle.ts';
import type { TaskOptions } from '../harness/runtime.ts';

const text = z.string().max(2000);
const items = z.array(text).max(20);
export const closeoutSchema = z.object({
  status: z.literal('budget_exhausted'), summary: text,
  completed: items, remaining: items, current_investigation: text,
  validation: z.object({ passed: items, failed: items }),
  workspace_state: text, human_question: text.nullable(),
});
export type TaskCloseout = z.infer<typeof closeoutSchema>;
export function createCloseoutSubmission(options: TaskOptions) {
  let value: TaskCloseout | undefined;
  return {
    get: () => value,
    tool: createTool({ id: 'submit_task_closeout',
      description: 'Pause unfinished repair because execution budget ended. Report completed work, remaining work, current investigation and known validation. Does not declare success or publish code.',
      inputSchema: closeoutSchema,
      execute: async input => { value ??= input; options.trace.emit('task_closeout_submitted', { task: options.task, closeout: value });
        return { status: 'closeout_submitted' }; },
    }),
  };
}

export async function closeoutFacts(options: TaskOptions) {
  const { ws, trace } = options;
  const observe = async (args: string[]) => {
    try { const result = await git(ws.path, args, undefined, undefined, true); return result.exitCode === 0 ? result.stdout.trim() : null; }
    catch { return null; }
  };
  const head = await observe(['rev-parse', 'HEAD']);
  const dirty = await observe(['status', '--porcelain']);
  const unresolved = await observe(['diff', '--name-only', '--diff-filter=U']);
  const validation = await readArtifact(trace.dir, 'last-validation.json').catch(() => null);
  const manifest = await readArtifact(trace.dir, 'manifest.json').catch(() => null);
  let lastTool: { tool: string; exit_code: number | null; error: boolean } | null = null;
  let lastEvent: string | null = null, verificationRequested = false, humanRequested = false, pushed: string | null = null;
  for await (const line of createInterface({ input: createReadStream(join(trace.dir, 'trace.jsonl')), crlfDelay: Infinity })) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    lastEvent = event.event;
    if (event.event === 'tool_end') lastTool = { tool: event.tool, exit_code: event.exit_code, error: !!event.error };
    if (event.event === 'repair_verification_requested') verificationRequested = true;
    if (event.event === 'human_help_requested') humanRequested = true;
    if (event.event === 'repair_push_confirmed') pushed = event.sha;
  }
  return { pr_head: ws.initialHead, base_sha: manifest?.base_sha ?? ws.mainSha, main_sha: ws.mainSha, local_head: head,
    unresolved_count: unresolved === null ? null : unresolved.split('\n').filter(Boolean).length,
    dirty: dirty === null ? null : !!dirty, committed: head === null ? null : head !== ws.initialHead,
    push_state: pushed ? `confirmed:${pushed}` : 'no_harness_push_confirmation',
    validation: validation ? { task: validation.task, ok: validation.ok, failures: validation.failures, reason: validation.reason,
      checks: validation.validation?.map((v: { command: string; exitCode: number; timedOut: boolean }) =>
        ({ command: v.command, exit_code: v.exitCode, timed_out: v.timedOut })) } : null,
    last_completed_tool: lastTool, last_event: lastEvent,
    verification_requested: verificationRequested, human_help_requested: humanRequested };
}

export async function persistCloseout(options: TaskOptions, thread: string, authored: TaskCloseout | undefined, issue: string) {
  const facts = await closeoutFacts(options);
  const closeout = authored ?? { status: 'budget_exhausted' as const,
    summary: '本轮执行预算已用完，候选修复尚未完成；未获得 Agent 结构化收尾，以下为 Harness 可观测事实。',
    completed: [], remaining: [issue], current_investigation: '未获得 Agent 说明，不能从工具日志推断调查意图。',
    validation: { passed: [], failed: [] }, workspace_state: '以 Harness Git 检查为准', human_question: null };
  if (!authored) options.trace.emit('task_closeout_fallback', { task: options.task });
  const artifact = { ...closeout, source: authored ? 'agent' : 'harness', run_id: options.runId, task: options.task,
    execution_id: options.trace.executionId,
    pr_thread_id: thread, workspace_path: options.ws.path, timestamp: new Date().toISOString(), facts };
  options.trace.save('closeout.json', artifact);
  options.trace.emit('budget_exhausted', { task: options.task, closeout: 'closeout.json' });
  return { status: 'budget_exhausted' as const, summary: formatCloseout(artifact), closeout: 'closeout.json' };
}

export function formatCloseout(value: TaskCloseout & { source: string; facts: Awaited<ReturnType<typeof closeoutFacts>> }) {
  const list = (values: string[]) => values.length ? values.map(v => `- ${v}`).join('\n') : '- 未报告';
  const f = value.facts;
  return [`本轮执行预算已用完，候选修复尚未完成。\n${value.summary}`,
    `### 已完成（${value.source === 'agent' ? 'Agent 报告' : '机械兜底'}）\n${list(value.completed)}`,
    `### 尚未完成\n${list(value.remaining)}`, `### 中断时正在调查\n${value.current_investigation}`,
    `### Agent 已知验证\n通过：\n${list(value.validation.passed)}\n失败：\n${list(value.validation.failed)}`,
    `### Harness 验证与发布事实\nPR head：${f.pr_head}\n本地 HEAD：${f.local_head ?? '未知'}\nBase/main：${f.base_sha}`,
    `未解决冲突：${f.unresolved_count ?? '未知'}；工作区：${f.dirty === null ? '未知' : f.dirty ? '有未提交修改' : '干净'}；本地 HEAD ${f.committed === null ? '未知' : f.committed ? '已变化' : '未变化'}。`,
    `推送：${f.push_state === 'no_harness_push_confirmation' ? '本轮 Harness 无成功推送确认；不能视为已交付' : f.push_state}`,
    `最近持久验收：${f.validation ? JSON.stringify(f.validation) : '尚无记录'}\n最近完成工具：${JSON.stringify(f.last_completed_tool)}\n最近事件：${f.last_event}`,
    `已提交验收请求：${f.verification_requested}；已提交人工求助：${f.human_help_requested}。`,
    ...(value.human_question ? [`待人类回答：${value.human_question}`] : []),
    '继续方式：在 PR 中 @ 机器人并发送 /conflict（冲突任务）或 /CI（CI 任务）。/conflict 仅在远端 head/base/main 未变且工作区可安全接管时继续原候选；否则保留旧证据并重新准备工作区。',
  ].join('\n\n').slice(0, 24000);
}
