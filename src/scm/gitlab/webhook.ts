import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeGitLabPath, storageKey } from '../identity.ts';
import type { InboundScmComment } from '../types.ts';

function equal(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyLegacyToken(received: string | undefined, expected: string) {
  if (!received || !expected) return false;
  return equal(Buffer.from(received), Buffer.from(expected));
}

export function decodeStandardSigningToken(token: string) {
  if (!token.startsWith('whsec_')) throw new Error('GitLab Standard Webhooks signing token must start with whsec_');
  const encoded = token.slice('whsec_'.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('GitLab Standard Webhooks signing token is not valid base64');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('GitLab Standard Webhooks signing token must decode to 32 bytes');
  return key;
}

export function verifyStandardSignature(input: { body: Buffer; signature?: string; webhookId?: string; timestamp?: string; secret: string; maxAgeSeconds?: number; nowMs?: number }) {
  const { body, signature, webhookId, timestamp, secret } = input;
  if (!signature || !webhookId || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const age = Math.abs((input.nowMs ?? Date.now()) - Number(timestamp) * 1000);
  if (age > (input.maxAgeSeconds ?? 300) * 1000) return false;
  const key = decodeStandardSigningToken(secret);
  const expected = `v1,${createHmac('sha256', key).update(`${webhookId}.${timestamp}.`).update(body).digest('base64')}`;
  return signature.split(/\s+/).filter(Boolean).some(value => equal(Buffer.from(value), Buffer.from(expected)));
}

function positive(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }

export function normalizeNoteHook(payload: any, connectionId: string, sourceEventId: string, botUserId?: string, botLogin?: string): InboundScmComment | null {
  if (payload?.object_kind !== 'note' && payload?.event_type !== 'note') return null;
  const attrs = payload.object_attributes;
  const mr = payload.merge_request;
  const project = payload.project;
  if (!attrs || attrs.action !== 'create' || attrs.system === true || attrs.noteable_type !== 'MergeRequest' || attrs.position || !mr || !project) return null;
  const remoteId = positive(attrs.id);
  const iid = positive(mr.iid);
  const authorId = positive(payload.user?.id ?? attrs.author_id);
  const body = typeof attrs.note === 'string' ? attrs.note : '';
  const path = typeof project.path_with_namespace === 'string' ? normalizeGitLabPath(project.path_with_namespace) : '';
  const authorLogin = typeof payload.user?.username === 'string' ? payload.user.username : typeof payload.user?.name === 'string' ? payload.user.name : '';
  if (!botUserId || !botLogin) return null;
  const mention = new RegExp(`(^|[^A-Za-z0-9_-])@${botLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`, 'i').test(body);
  if (!remoteId || !iid || !authorId || !body || !path || !authorLogin || !mention || String(authorId) === String(botUserId)) return null;
  const url = typeof attrs.url === 'string' ? attrs.url : typeof mr.web_url === 'string' ? mr.web_url : '';
  if (!url) return null;
  return { platform: 'gitlab', connectionId, projectId: String(project.id), changeRequestNumber: iid,
    storageKey: storageKey('gitlab', connectionId, String(project.id)), repositoryPath: path,
    remoteId, authorId: String(authorId), authorLogin, body, url,
    ...(typeof attrs.created_at === 'string' ? { createdAt: attrs.created_at } : {}), sourceEventId };
}
