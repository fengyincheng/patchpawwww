import { createHash } from 'node:crypto';
import { invalid } from '../control-plane/errors.ts';
import type { ScmKind } from './types.ts';

export function normalizeInstanceUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { invalid('SCM instance URL must be an absolute HTTP(S) URL.', 'instance_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    invalid('SCM instance URL must not contain credentials, query parameters, or fragments.', 'instance_url');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function normalizeGitLabPath(value: string) {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/').map(part => part.trim());
  if (!parts.length || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part))) {
    invalid('GitLab project path must be a safe namespace/project path.', 'path_with_namespace');
  }
  return parts.map(part => part.toLowerCase()).join('/');
}

export function storageKey(kind: ScmKind, connectionId: string, remoteProjectId: string | number) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(connectionId)) throw new Error('Invalid SCM connection id');
  if (!String(remoteProjectId).trim()) throw new Error('Remote project id is required');
  return `${kind}:${connectionId}:project:${String(remoteProjectId)}`;
}

export function safeStorageDirectory(storage: string) {
  return `v2-${createHash('sha256').update(storage, 'utf8').digest('hex')}`;
}

export function changeRequestThreadId(kind: ScmKind, storage: string, number: number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Change request number must be positive');
  return `${kind}:${storage}:mr:${number}`;
}

export function encodeProjectId(projectId: string | number) {
  return encodeURIComponent(String(projectId));
}

export function isSameInstance(left: string, right: string) {
  return normalizeInstanceUrl(left).toLowerCase() === normalizeInstanceUrl(right).toLowerCase();
}
