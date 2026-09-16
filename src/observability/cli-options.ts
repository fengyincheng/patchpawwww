import type { RunTarget } from './run-resolver.ts';
import type { RenderMode } from './renderer.ts';

export interface TargetCommandOptions {
  target: RunTarget;
  mode: RenderMode;
  replay: number | 'all';
  wait: boolean;
  help: boolean;
}

function modeFor(mode: RenderMode, next: RenderMode) {
  if (mode !== 'readable' && mode !== next) throw new Error('Choose only one output mode.');
  return next;
}

export function parseTargetCommandArgs(args: string[], command: string): TargetCommandOptions {
  let runId: string | undefined;
  let repo: string | undefined;
  let changeNumber: number | undefined;
  let mode: RenderMode = 'readable';
  let replay: number | 'all' = 50;
  let wait = false;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--run') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error('--run requires a run identifier.');
      runId = value;
    }
    else if (arg === '--replay') {
      const raw = args[++index];
      const value = Number(raw);
      if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(value)) throw new Error('--replay requires a non-negative safe integer.');
      replay = value;
    } else if (arg === '--all') replay = 'all';
    else if (arg === '--compact') mode = modeFor(mode, 'compact');
    else if (arg === '--verbose') mode = modeFor(mode, 'verbose');
    else if (arg === '--json') mode = modeFor(mode, 'json');
    else if (arg === '--wait') wait = true;
    else if (arg === '--help' || arg === '-h') return { target: {}, mode, replay, wait, help: true };
    else if (arg.startsWith('-')) throw new Error(`Unknown ${command} option: ${arg}`);
    else positionals.push(arg);
  }
  if (runId && positionals.length) throw new Error('--run cannot be combined with <repo> <PR/MR number>.');
  if (runId) return { target: { runId }, mode, replay, wait, help: false };
  if (positionals.length !== 2 || !/^\d+$/.test(positionals[1]!)) throw new Error(`Usage: npm run ${command} -- <repo> <PR/MR number> | --run <run-id>`);
  repo = positionals[0]; changeNumber = Number(positionals[1]);
  return { target: { repo, changeNumber }, mode, replay, wait, help: false };
}

export function parseRunsArgs(args: string[]) {
  let mode: RenderMode = 'readable';
  let failed = false;
  let includeCorrupt = false;
  let limit = 20;
  let repo: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--failed') failed = true;
    else if (arg === '--include-corrupt') includeCorrupt = true;
    else if (arg === '--limit') {
      const raw = args[++index];
      const value = Number(raw);
      if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(value) || value < 1) throw new Error('--limit requires a positive safe integer.');
      limit = value;
    } else if (arg === '--repo') {
      repo = args[++index];
      if (!repo || repo.startsWith('-')) throw new Error('--repo requires a repository name.');
    }
    else if (arg === '--compact') mode = modeFor(mode, 'compact');
    else if (arg === '--verbose') mode = modeFor(mode, 'verbose');
    else if (arg === '--json') mode = modeFor(mode, 'json');
    else if (arg === '--help' || arg === '-h') return { mode, failed, includeCorrupt, limit, repo, help: true };
    else throw new Error(`Unknown agent:runs option: ${arg}`);
  }
  return { mode, failed, includeCorrupt, limit, repo, help: false };
}

export const TARGET_COMMAND_HELP = 'Usage: npm run agent:open -- <repo> <PR/MR number> | --run <run-id> [--replay N|--all] [--compact|--verbose|--json] [--wait]';
