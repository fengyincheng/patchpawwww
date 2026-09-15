import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { configuredRuntimeHome as runtimeHomeFromEnvironment, patchpawPaths, type PatchPawPaths } from './paths.ts';
import { normalizeInstanceUrl } from '../scm/identity.ts';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export const configuredRuntimeHome = runtimeHomeFromEnvironment;

const optionalEnvString = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, schema.optional());
const optionalEnvNumber = z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.coerce.number().int().positive().optional());

export function loadConfig() {
  // Absolute path: PM2/restarts do not depend on the caller's working directory.
  loadEnvFile(resolve(projectRoot, '.env'));
  const env = z.object({
    PATCHPAW_GITHUB_APP_ID: optionalEnvNumber,
    PATCHPAW_GITHUB_APP_SLUG: optionalEnvString(z.string().trim().regex(/^[\w.-]+$/)),
    PATCHPAW_GITHUB_WEBHOOK_SECRET: optionalEnvString(z.string().min(1)),
    PATCHPAW_GITHUB_PRIVATE_KEY_PATH: optionalEnvString(z.string().min(1)),
    PATCHPAW_PUBLIC_ORIGIN: z.url(),
    PATCHPAW_PORT: z.coerce.number().int().min(1).max(65535),
    PATCHPAW_GITHUB_TEST_REPO: optionalEnvString(z.string().regex(/^[\w.-]+\/[\w.-]+$/)),
    PATCHPAW_OPERATOR_GITHUB_LOGIN: optionalEnvString(z.string().trim()),
    PATCHPAW_ADMIN_TOKEN: z.string().min(1).optional(),
    PATCHPAW_HOME: z.string().trim().optional(),
    PATCHPAW_LEGACY_HOME: z.string().trim().optional(),
    PATCHPAW_GITLAB_CONNECTIONS: z.string().trim().optional(),
  }).safeParse(process.env);
  if (!env.success) {
    throw new Error(`Invalid configuration fields: ${env.error.issues.map(i => i.path.join('.')).join(', ')}`);
  }
  const value = env.data;
  const githubFields = [value.PATCHPAW_GITHUB_APP_ID, value.PATCHPAW_GITHUB_APP_SLUG, value.PATCHPAW_GITHUB_WEBHOOK_SECRET, value.PATCHPAW_GITHUB_PRIVATE_KEY_PATH, value.PATCHPAW_GITHUB_TEST_REPO];
  const githubConfigured = githubFields.every(Boolean);
  if (!githubConfigured && githubFields.some(Boolean)) throw new Error('GitHub configuration is incomplete; set all PATCHPAW_GITHUB_* fields or disable GitHub.');
  let gitlabConnections: Array<{
    id: string; instanceUrl: string; projectIds: string[]; token?: string; webhookMode: 'secret' | 'signing'; webhookSecret?: string;
    botUserId?: string; botLogin?: string;
  }> = [];
  if (value.PATCHPAW_GITLAB_CONNECTIONS) {
    let parsed: unknown;
    try { parsed = JSON.parse(value.PATCHPAW_GITLAB_CONNECTIONS); } catch { throw new Error('PATCHPAW_GITLAB_CONNECTIONS must be valid JSON.'); }
    const result = z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), instance_url: z.string().min(1), project_ids: z.array(z.string().min(1)).default([]),
      token: z.string().min(1).optional(), token_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      webhook_mode: z.enum(['secret', 'signing']).default('secret'), webhook_secret: z.string().min(1).optional(), webhook_secret_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      bot_user_id: z.string().optional(), bot_login: z.string().optional(),
    }).strict()).safeParse(parsed);
    if (!result.success) throw new Error('PATCHPAW_GITLAB_CONNECTIONS contains an invalid connection.');
    gitlabConnections = result.data.map(item => ({ id: item.id, instanceUrl: normalizeInstanceUrl(item.instance_url), projectIds: item.project_ids.map(value => String(value).trim().toLowerCase()),
      token: item.token ?? (item.token_env ? process.env[item.token_env] : undefined), webhookMode: item.webhook_mode,
      webhookSecret: item.webhook_secret ?? (item.webhook_secret_env ? process.env[item.webhook_secret_env] : undefined), botUserId: item.bot_user_id, botLogin: item.bot_login }));
    if (gitlabConnections.some(item => !item.token || !item.webhookSecret)) throw new Error('Every GitLab connection needs a token and webhook secret.');
  }
  const runtimeHome = configuredRuntimeHome(value.PATCHPAW_HOME);
  const paths: PatchPawPaths = patchpawPaths(runtimeHome);
  if (!githubConfigured && !gitlabConnections.length && !existsSync(paths.controlPlaneDb)) throw new Error('Configure GitHub App, a GitLab connection, or an existing control-plane connection.');
  return {
    githubConfigured,
    appId: value.PATCHPAW_GITHUB_APP_ID ?? 0,
    appSlug: value.PATCHPAW_GITHUB_APP_SLUG,
    botLogin: value.PATCHPAW_GITHUB_APP_SLUG ? `${value.PATCHPAW_GITHUB_APP_SLUG}[bot]` : undefined,
    webhookSecret: value.PATCHPAW_GITHUB_WEBHOOK_SECRET ?? '',
    privateKey: value.PATCHPAW_GITHUB_PRIVATE_KEY_PATH ? readFileSync(resolve(projectRoot, value.PATCHPAW_GITHUB_PRIVATE_KEY_PATH), 'utf8') : '',
    publicOrigin: value.PATCHPAW_PUBLIC_ORIGIN,
    port: value.PATCHPAW_PORT,
    testRepo: value.PATCHPAW_GITHUB_TEST_REPO ?? '',
    operatorLogin: value.PATCHPAW_OPERATOR_GITHUB_LOGIN || undefined,
    adminToken: value.PATCHPAW_ADMIN_TOKEN || undefined,
    runtimeHome,
    legacyHome: value.PATCHPAW_LEGACY_HOME || undefined,
    paths,
    snapshotRoot: paths.snapshots,
    gitlabConnections,
  };
}
