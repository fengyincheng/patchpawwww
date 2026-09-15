import { TaskStopped } from '../runner/stop.ts';
import { createCodingAgent } from '@mastra/core/coding-agent';
import type { ToolsInput } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { taskMemory, type PRMemory } from './pr-memory.ts';
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createModel } from './model.ts';
import { ProviderUnavailable } from './retry.ts';
import { contextPolicy, excerpt, isOutputTruncated } from './context/policy.ts';
import { bounded } from './trace.ts';
import { budget } from './budget.ts';
import { git } from '../workspace/git.ts';
import { validateRepoRelativePath } from '../workspace/repo-store.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import type { Trace } from './trace.ts';
import { createHumanHelp, humanHelpSkill, HumanHelpRequested } from '../tasks/human-help.ts';
import { loadOperation, renderOperation } from '../operation/load.ts';
import { renderTemplate, type TemplateValue } from '../control-plane/templates.ts';
import { ControlPlaneError } from '../control-plane/errors.ts';
import type { CommandSnapshot } from '../control-plane/snapshots.ts';
import type { ResolvedModelSelection } from '../models/types.ts';
import { resolveOutputBudget, type OutputBudget } from '../models/output-budget.ts';
import { workspaceCommandEnvironment } from '../platform/command-environment.ts';

export interface RuntimeExecution {
  snapshot: CommandSnapshot;
  modelSelection: ResolvedModelSelection;
  outputBudget: OutputBudget;
}

const DEFERRED_PROMPT_ROLES = new Set([
  'conversation-retry', 'review-json-retry', 'repair-feedback', 'repair-no-verification',
  'repair-verification-empty', 'repair-closeout', 'runtime-budget', 'stop-closeout',
]);

export function runtimeExecutionFromSnapshot(snapshot: CommandSnapshot, runtimeHome: string, env: NodeJS.ProcessEnv = process.env): RuntimeExecution {
  const outputBudget = snapshot.output_budget ? {
    requested: snapshot.output_budget.requested, effective: snapshot.output_budget.effective, source: snapshot.output_budget.source,
    wireKey: snapshot.output_budget.wire_key, ...(snapshot.output_budget.capability === undefined ? {} : { capability: snapshot.output_budget.capability }),
  } : resolveOutputBudget(snapshot.provider.request_options);
  return { snapshot, outputBudget, modelSelection: {
    provider: { id: snapshot.provider.id, type: snapshot.provider.type as ResolvedModelSelection['provider']['type'],
      baseUrl: snapshot.provider.base_url, credentialRef: snapshot.provider.credential_ref,
      requestOptions: snapshot.provider.request_options, enabled: true },
    model: { id: snapshot.provider.model.id, identifier: snapshot.provider.model.identifier, enabled: true,
      ...(outputBudget.capability === undefined ? {} : { maxOutputTokens: outputBudget.capability }) }, runtimeHome, env,
  } };
}

function snapshotInstructions(execution: RuntimeExecution, values: Record<string, TemplateValue> = {}) {
  return execution.snapshot.composition.parts.map(part => {
    const label = part.kind === 'prompt' ? `Prompt ${part.role ?? part.slug}` : `Skill ${part.slug}`;
    let content = part.content;
    if (part.kind === 'prompt') {
      try { content = renderTemplate(part.content, values, { templateType: execution.snapshot.template_type, role: part.role }); }
      catch (error) {
        // Closeout/budget Prompt roles are intentionally included in the immutable
        // stack but receive their values only when that lifecycle path is entered.
        if (!DEFERRED_PROMPT_ROLES.has(part.role ?? '') || !(error instanceof ControlPlaneError) || error.code !== 'missing_required_template_variable') throw error;
      }
    }
    return `## ${label}\n${content}`;
  }).join('\n\n');
}

/** Render an editable Prompt from the immutable runtime snapshot. */
export function renderRuntimePrompt(options: Pick<TaskOptions, 'execution'>, role: string, values: Record<string, TemplateValue>): string;
export function renderRuntimePrompt(options: Pick<TaskOptions, 'execution'>, role: string, values: Record<string, TemplateValue>, optional: true): string | undefined;
export function renderRuntimePrompt(options: Pick<TaskOptions, 'execution'>, role: string, values: Record<string, TemplateValue>, optional = false): string | undefined {
  if (!options.execution) {
    // Direct lower-level callers predate the snapshot seam and pass the whole
    // seed object. Preserve their old source-operation behavior while avoiding
    // the legacy renderer's unused-value failure for unrelated runtime facts.
    const source = loadOperation(role);
    const used = new Set([...source.matchAll(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g)].map(match => match[1]));
    const relevant = Object.fromEntries(Object.entries(values).filter(([key]) => used.has(key))) as Record<string, string | number>;
    return renderOperation(role, relevant);
  }
  const part = options.execution.snapshot.composition.parts.find(value => value.kind === 'prompt' && value.role === role);
  if (!part) {
    if (optional) return undefined;
    throw new Error(`Required runtime Prompt role is missing from command snapshot: ${role}`);
  }
  return renderTemplate(part.content, values, { templateType: options.execution.snapshot.template_type, role });
}

export function templateValuesFromSeed(seed: unknown): Record<string, TemplateValue> {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return {};
  const source = seed as Record<string, unknown>;
  const values: Record<string, TemplateValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = value as TemplateValue;
  }
  const aliases: Record<string, string> = {
    repositoryFullName: 'repository', prNumber: 'pr_number', prTitle: 'title', prBody: 'body',
    prHeadSha: 'head_sha', baseSha: 'base_sha', baseRef: 'current_base_ref', currentBaseTipSha: 'current_base_tip_sha',
    executionId: 'execution_id',
  };
  for (const [target, sourceKey] of Object.entries(aliases)) if (values[target] === undefined && values[sourceKey] !== undefined) values[target] = values[sourceKey];
  return values;
}

export interface TaskOptions {
  task: string; prompt: string; ws: WorkspaceState; trace: Trace; runId: string; readOnly?: boolean; evidence?: unknown;
  /** Custom read/write writeback is Harness-owned; the Agent may edit and commit, but not push. */
  preventGitPush?: boolean;
  currentBase?: CurrentBaseSnapshot;
  execution?: RuntimeExecution;
  templateValues?: Record<string, TemplateValue>;
  tools?: ToolsInput; stopWhen?: () => boolean;
  /** Pending Conflict discussion may submit a new proposal revision, but stays read-only. */
  conflictDiscussion?: { proposalId: string; revision: number; hash: string };
  repairStartHead?: string;
  stopSignal?: AbortSignal; stopRequest?: () => unknown;
  prMemory?: PRMemory; repairBudget?: boolean;
  onCloseout?: () => Promise<void>;
}
export interface CurrentBaseSnapshot { ref: string; sha: string; }

export function isGitPushCommand(command: string) {
  return /(?:^|[;&|()\n])\s*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?git(?:\s+\S+){0,8}\s+push(?:\s|$)/i.test(command);
}

export interface TaskTurnResult {
  text: string;
  finishReason?: string;
  usage?: unknown;
  runId?: string;
  maxOutputTokens: number;
  evidencePath: string;
}

export class ModelOutputTruncated extends Error {
  readonly code = 'model_output_truncated';
  constructor(readonly details: {
    task: string;
    finishReason: string;
    maxOutputTokens: number;
    usage?: unknown;
    evidencePath: string;
    provider?: string;
    model?: string;
  }) {
    super(`Model output truncated at ${details.maxOutputTokens} tokens before a complete ${details.task} result was produced`);
    this.name = 'ModelOutputTruncated';
  }
}

function currentBaseToolResult(currentBase: CurrentBaseSnapshot, path: string | null | undefined, value: string, offset: number) {
  return { revision_role: 'current_base_tip', revision_ref: currentBase.ref, revision_sha: currentBase.sha,
    ...(path === undefined ? {} : { path }), ...excerpt(value, contextPolicy.evidencePageChars, offset) };
}

function currentBaseTools(ws: WorkspaceState, currentBase: CurrentBaseSnapshot, trace: Trace) {
  const revision = currentBase.sha;
  if (!/^[0-9a-f]{7,64}$/i.test(revision)) throw new Error('Current base revision must be a Git object ID');
  return {
    read_current_base_file: createTool({ id: 'read_current_base_file',
      description: 'Read one file from the exact current target-branch tip fetched for this run; the revision is Harness-pinned. Paginate by character offset.',
      inputSchema: z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().default(0) }),
      execute: async ({ path, offset }) => {
        const safePath = validateRepoRelativePath(path);
        const result = await git(ws.path, ['show', `${revision}:${safePath}`], trace);
        return currentBaseToolResult(currentBase, safePath, result.stdout, offset);
      } }),
    grep_current_base: createTool({ id: 'grep_current_base',
      description: 'Search the exact current target-branch tip fetched for this run using literal text; the revision is Harness-pinned. Optional path narrows the search. Paginate by character offset.',
      inputSchema: z.object({ query: z.string().min(1), path: z.string().optional(), offset: z.number().int().nonnegative().default(0) }),
      execute: async ({ query, path, offset }) => {
        const safePath = path === undefined ? undefined : validateRepoRelativePath(path);
        const result = await git(ws.path, ['grep', '-n', '-I', '-F', '-e', query, revision, '--', ...(safePath ? [safePath] : [])], trace, undefined, true);
        if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) {
          throw new Error('Git grep failed (exit ' + result.exitCode + (result.timedOut ? ', timed out' : '') + ')');
        }
        return currentBaseToolResult(currentBase, safePath, result.stdout, offset);
      } }),
    list_current_base_files: createTool({ id: 'list_current_base_files',
      description: 'List repository paths at the exact current target-branch tip fetched for this run; the revision is Harness-pinned. Optional path narrows the listing. Paginate by character offset.',
      inputSchema: z.object({ path: z.string().optional(), offset: z.number().int().nonnegative().default(0) }),
      execute: async ({ path, offset }) => {
        const safePath = path === undefined ? undefined : validateRepoRelativePath(path);
        const result = await git(ws.path, ['ls-tree', '-r', '--name-only', revision, '--', ...(safePath ? [safePath] : [])], trace);
        return currentBaseToolResult(currentBase, safePath, result.stdout, offset);
      } }),
  };
}

// Task-specific tools are supplied by the runner, but a read-only task must not trust an
// arbitrary caller-provided tool merely because the workspace filesystem is read-only. Keep the
// allowlist narrow: these tools can inspect evidence, ask for human help, publish a reply, or
// submit a structured proposal; none can mutate the checkout.
const READ_ONLY_CUSTOM_TOOLS = new Set([
  'read_pr_comments', 'read_ci_evidence', 'git_diff', 'reply_to_pr',
  'submit_stop_report', 'request_human_help', 'submit_conflict_proposal', 'validate_conflict_proposal',
]);

function taskTools(options: TaskOptions, readOnly: boolean) {
  if (!readOnly || !options.tools) return options.tools;
  return Object.fromEntries(Object.entries(options.tools).filter(([name]) => READ_ONLY_CUSTOM_TOOLS.has(name)));
}

export function createTaskSession(options: TaskOptions) {
  const { task, ws, trace } = options;
  const snapshotReadOnly = options.execution?.snapshot.command?.permission === 'read_only'
    || options.execution?.snapshot.conversation_profile?.permission === 'read_only'
    || ['review', 'conversation'].includes(task);
  const readOnly = snapshotReadOnly || (options.readOnly ?? false);
  const help = createHumanHelp(trace, task);
  const sessionId = `${task}-${randomUUID().slice(0, 8)}`;
  const outputBudget = options.execution?.outputBudget ?? resolveOutputBudget(options.execution?.modelSelection.provider.requestOptions ?? {});
  const model = createModel(trace, sessionId, options.execution?.modelSelection);
  const { storage, state } = taskMemory(options.prMemory, options.runId, trace.dir);
  const memory = new Memory({ storage, options: { lastMessages: contextPolicy.lastMessages,
    semanticRecall: false, workingMemory: { enabled: false }, generateTitle: false } });
  const readTools = new Set(['mastra_workspace_read_file', 'mastra_workspace_grep', 'mastra_workspace_list_files', 'mastra_workspace_file_stat']);
  const tools = Object.fromEntries(Object.values(WORKSPACE_TOOLS).flatMap(group => Object.values(group)).map(name => [name,
    { enabled: !readOnly || readTools.has(name), requireApproval: false, requireReadBeforeWrite: false, maxOutputTokens: contextPolicy.toolOutputTokens }]));
  const workspace = new Workspace({ filesystem: new LocalFilesystem({ basePath: ws.path, readOnly }),
    sandbox: readOnly ? undefined : new LocalSandbox({ workingDirectory: ws.path, timeout: 300_000,
      env: workspaceCommandEnvironment() }), tools });
  let stopReport: string | undefined;
  let stopping = false;
  let toolIndex = 0;
  const starts = new Map<string, { index: number; time: number }[]>();
  const staticInstructions = options.execution ? snapshotInstructions(options.execution, options.templateValues) : `${options.prompt}\n${humanHelpSkill}\n${loadOperation('shared')}`;
  const agent = createCodingAgent({ id: task, name: `PatchPaw ${task}`, model: model.model, workspace, memory,
    errorProcessors: [], // Retry policy is centralized at the current provider call, with no hidden second retry stack.
    instructions: `${staticInstructions}\nNative tool output is capped at ${contextPolicy.toolOutputTokens} tokens. Use offset/limit or focused search when truncated; suggested read size ${contextPolicy.suggestedReadLines} lines.`,
    tools: {
      ...taskTools(options, readOnly),
      ...(options.currentBase && ['review', 'conversation', 'custom', 'conflict'].includes(task) ? currentBaseTools(ws, options.currentBase, trace) : {}),
      submit_stop_report: createTool({ id: 'submit_stop_report', description: 'Report progress after a human /stop request; preserve unfinished work and wait for further instructions.',
        inputSchema: z.object({ summary: z.string().min(1).max(12000) }),
        execute: async ({ summary }) => { stopReport = summary; return { status: 'stopped' }; } }),
      request_human_help: help.tool,
      git_diff: createTool({ id: 'git_diff', description: 'Read the changes introduced by this PR from the merge-base of the current target tip and PR HEAD to HEAD. This is the PR diff, not current target-branch file content; use current-base read/search tools for that. Paginate by character offset. Optional path narrows the diff.',
        inputSchema: z.object({ path: z.string().optional(), offset: z.number().int().nonnegative().default(0) }),
        execute: async ({ path, offset }) => excerpt((await git(ws.path, ['diff', `${options.currentBase?.sha ?? ws.mainSha}...HEAD`, '--', ...(path ? [validateRepoRelativePath(path)] : [])], trace)).stdout,
          contextPolicy.evidencePageChars, offset) }),
      ...(options.evidence ? { read_ci_evidence: createTool({ id: 'read_ci_evidence', description: 'Read actual CI check/job results and failure logs; paginate by character offset.',
        inputSchema: z.object({ offset: z.number().int().nonnegative().default(0) }),
        execute: async ({ offset }) => excerpt(JSON.stringify(options.evidence), contextPolicy.evidencePageChars, offset) }) } : {}),
    },
    hooks: {
      beforeToolCall: ({ toolName, input }) => {
        if (!stopping && options.stopSignal?.aborted) throw new TaskStopped();
        if (options.preventGitPush && toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND
            && typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string'
            && isGitPushCommand(input.command)) {
          throw new Error('Custom read/write Agent cannot push; the Harness owns GitLab writeback.');
        }
        const key = toolName + JSON.stringify(input);
        const list = starts.get(key) ?? [];
        const item = { index: ++toolIndex, time: Date.now() }; list.push(item); starts.set(key, list);
        // Args are persisted bounded: edit/write tool args embed full file contents.
        const args = bounded(input);
        trace.emit('tool_start', { task, index: item.index, tool: toolName,
          args: args.truncated ? args.excerpt : input, args_chars: args.chars, args_sha256: args.truncated ? args.sha256 : undefined });
      },
      afterToolCall: ({ toolName, input, output, error }) => {
        const item = starts.get(toolName + JSON.stringify(input))?.shift();
        const serialized = JSON.stringify(output) ?? '';
        const exitMatch = typeof output === 'string' ? output.match(/Exit code: (-?\d+)/) : null;
        const foregroundCommand = toolName === 'mastra_workspace_execute_command' && !(input as { background?: boolean })?.background;
        // The durable trace keeps diagnostic facts plus a bounded excerpt and fingerprint;
        // the Agent saw the full output, but trace.jsonl must not grow without limit.
        const payload = bounded(serialized);
        const args = bounded(input);
        trace.emit('tool_end', { task, index: item?.index, tool: toolName,
          args: args.truncated ? args.excerpt : input,
          duration_ms: item ? Date.now() - item.time : null, result_chars: serialized.length,
          output_excerpt: payload.excerpt, output_sha256: payload.sha256, output_truncated: payload.truncated,
          exit_code: exitMatch ? Number(exitMatch[1]) : foregroundCommand && !error ? 0 : null,
          truncated: isOutputTruncated(output), error: error ? String(error) : null });
      },
    },
  });
  const mastra = new Mastra({ agents: { [task]: agent }, storage, logger: false });
  let turn = 0;
  const signal = AbortSignal.timeout(budget.taskMs);
  const interrupt = () => { void workspace.sandbox?.stop?.().catch(() => {}); };
  options.stopSignal?.addEventListener('abort', interrupt, { once: true });
  return {
    thread: state.thread,
    async freeze() { await workspace.sandbox?.stop?.(); },
    async turnResult(prompt: string, closeout: boolean | 'stop' = false): Promise<TaskTurnResult> {
      const index = ++turn;
      const maxSteps = closeout ? budget.closeoutSteps : budget.maxSteps;
      const activeTools = closeout === 'stop' ? ['submit_stop_report'] : closeout ? ['request_repair_verification', 'request_human_help', 'submit_task_closeout'] : undefined;
      trace.emit('task_turn_start', { task, turn: index, prompt, thread: state.thread, closeout });
      const result = await mastra.getAgent(task).generate(prompt, { memory: state, maxSteps,
        abortSignal: closeout === 'stop' ? AbortSignal.timeout(budget.closeoutMs) : AbortSignal.any([closeout ? AbortSignal.timeout(budget.closeoutMs) : signal, ...(options.stopSignal ? [options.stopSignal] : [])]),
        activeTools,
        prepareStep: ({ stepNumber, systemMessages, tools }) => {
          if (closeout) return { activeTools, tools: Object.fromEntries(Object.entries(tools ?? {}).filter(([name]) => activeTools!.includes(name))) };
          const normalTools = Object.fromEntries(Object.entries(tools ?? {}).filter(([name]) => name !== 'submit_stop_report'));
          if (!options.repairBudget) return { tools: normalTools };
          const remaining = maxSteps - stepNumber;
          if (remaining !== Math.min(10, maxSteps) && remaining !== 3) return { tools: normalTools };
          const critical = remaining <= 3;
          trace.emit(critical ? 'budget_critical' : 'budget_warning', { task, turn: index, remaining });
          const guidance = renderRuntimePrompt(options, 'runtime-budget', {
            remaining, guidance: critical ? 'Very little execution budget remains. Do not begin another broad repair loop.' : 'Approaching execution budget. Begin converging.'
          }, true);
          return guidance ? { tools: normalTools, systemMessages: [...systemMessages, { role: 'system', content: guidance }] } : { tools: normalTools };
        },
        stopWhen: () => stopping ? !!stopReport : !!options.stopSignal?.aborted || help.requested() || !!options.stopWhen?.(),
        modelSettings: { maxRetries: 0, temperature: 0.2, maxOutputTokens: outputBudget.effective },
        onStepFinish: step => { trace.emit('model_step', { task, finish_reason: step.finishReason, usage: step.usage }); },
      }).catch(async error => {
        if (closeout !== 'stop' && options.stopSignal?.aborted) return await this.stop();
        if (!closeout && signal.aborted) throw new ExecutionBudgetExhausted();
        if (error instanceof ProviderUnavailable) throw error;
        if (model.isUnavailable()) throw new ProviderUnavailable(); throw error;
      });
      if (closeout !== 'stop' && options.stopSignal?.aborted) return await this.stop();
      // Turn metadata only: the conversation history itself is durable in PR Memory, and the
      // per-turn message/step blobs used to duplicate it at tens of megabytes per long run.
      const evidencePath = `${sessionId}-turn-${index}.json`;
      trace.save(evidencePath, { text: result.text,
        usage: result.totalUsage, finishReason: result.finishReason, runId: result.runId, maxOutputTokens: outputBudget.effective });
      trace.emit('task_turn_end', { task, turn: index, text: result.text, finish_reason: result.finishReason });
      if (closeout !== 'stop' && help.requested()) throw new HumanHelpRequested(help.reason());
      if (model.isUnavailable()) throw new ProviderUnavailable();
      if (result.error) throw new Error('Agent runtime error');
      return { text: result.text, finishReason: result.finishReason, usage: result.totalUsage, runId: result.runId,
        maxOutputTokens: outputBudget.effective, evidencePath };
    },
    async turn(prompt: string, closeout: boolean | 'stop' = false): Promise<string> {
      return (await this.turnResult(prompt, closeout)).text;
    },
    async stop(): Promise<never> {
      if (stopping) throw new TaskStopped(stopReport ?? new TaskStopped().message);
      stopping = true;
      await workspace.sandbox?.stop?.();
      await memory.settled();
      trace.emit('human_stop_closeout_started', { task, thread: state.thread });
      try {
        const closeout = renderRuntimePrompt(options, 'stop-closeout', { humanMessage: JSON.stringify(options.stopRequest?.() ?? null) }, true);
        if (closeout) await this.turn(closeout, 'stop');
      }
      catch (error) { trace.emit('human_stop_closeout_failed', { message: (error as Error).message }); }
      const summary = stopReport ?? new TaskStopped().message;
      trace.save('stop-report.json', { status: 'stopped', source: stopReport ? 'agent' : 'harness', summary, thread: state.thread });
      throw new TaskStopped(summary);
    },
    async close() { options.stopSignal?.removeEventListener('abort', interrupt); try { await memory.settled(); } finally { try { await workspace.destroy(); } finally { await storage.close(); } } },
  };
}

export class ExecutionBudgetExhausted extends Error {}

export function parseResult<T>(text: string, schema: z.ZodType<T>) {
  const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return schema.safeParse((() => { try { return JSON.parse(clean); } catch { return null; } })());
}
