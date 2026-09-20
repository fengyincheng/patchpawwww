import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resumePendingClose } from './close.ts';
import { patchpawPaths } from '../config/paths.ts';
import type { FinalizationContext } from './communication-finalization.ts';
import { readState, statePath, writeState } from './state.ts';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function json(path: string): Promise<JsonObject | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isJsonObject(value)) throw new Error(`Expected JSON object at ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function finalizeCloseRefusal(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  if (item.source.comment_id !== undefined) {
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const state = await readState(path);
    if (state?.pending_close_refusal?.comment_id === Number(item.source.comment_id)) {
      await writeState(path, { ...state, pending_close_refusal: undefined });
    }
  }
  return done();
}

export async function finalizeCloseCompletion(context: FinalizationContext) {
  const { config, stored, done } = context;
  const item = stored.item;
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  const state = await readState(path);
  const closeCommentId = Number(item.source.close_comment_id);
  const ownsClose = state?.close_comment_id !== undefined
    ? state.close_comment_id === closeCommentId
    : state?.closed_through_comment_id === closeCommentId;
  if (state?.completion_notice_status === 'pending' && ownsClose) {
    await writeState(path, { ...state, completion_notice_status: 'published', completion_notice_id: item.receipt?.id });
  }
  return done();
}

export async function finalizeCloseStart(context: FinalizationContext) {
  const { config, stored, resolveConnection, done } = context;
  const item = stored.item;
  const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
  const journal = await json(`${path}.close.json`);
  if (journal?.status === 'closing') {
    const resolved = await resolveConnection();
    if (!resolved) throw new Error('SCM connection required for close finalization');
    await resumePendingClose(config, item.repo, item.pr_number, path, resolved, resolved.botLogin);
  }
  return done();
}
