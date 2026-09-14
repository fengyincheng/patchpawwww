import { readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { configuredRuntimeHome as runtimeHomeFromEnvironment, patchpawPaths, type PatchPawPaths } from './paths.ts';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export const configuredRuntimeHome = runtimeHomeFromEnvironment;

export function loadConfig() {
  // Absolute path: PM2/restarts do not depend on the caller's working directory.
  loadEnvFile(resolve(projectRoot, '.env'));
  const env = z.object({
    PATCHPAW_GITHUB_APP_ID: z.coerce.number().int().positive(),
    PATCHPAW_GITHUB_APP_SLUG: z.string().trim().regex(/^[\w.-]+$/),
    PATCHPAW_GITHUB_WEBHOOK_SECRET: z.string().min(1),
    PATCHPAW_GITHUB_PRIVATE_KEY_PATH: z.string().min(1),
    PATCHPAW_PUBLIC_ORIGIN: z.url(),
    PATCHPAW_PORT: z.coerce.number().int().min(1).max(65535),
    PATCHPAW_GITHUB_TEST_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    PATCHPAW_OPERATOR_GITHUB_LOGIN: z.string().trim().optional(),
    PATCHPAW_ADMIN_TOKEN: z.string().min(1).optional(),
    PATCHPAW_HOME: z.string().trim().optional(),
    PATCHPAW_LEGACY_HOME: z.string().trim().optional(),
  }).safeParse(process.env);
  if (!env.success) {
    throw new Error(`Invalid configuration fields: ${env.error.issues.map(i => i.path.join('.')).join(', ')}`);
  }
  const value = env.data;
  const runtimeHome = configuredRuntimeHome(value.PATCHPAW_HOME);
  const paths: PatchPawPaths = patchpawPaths(runtimeHome);
  return {
    appId: value.PATCHPAW_GITHUB_APP_ID,
    appSlug: value.PATCHPAW_GITHUB_APP_SLUG,
    botLogin: `${value.PATCHPAW_GITHUB_APP_SLUG}[bot]`,
    webhookSecret: value.PATCHPAW_GITHUB_WEBHOOK_SECRET,
    privateKey: readFileSync(resolve(projectRoot, value.PATCHPAW_GITHUB_PRIVATE_KEY_PATH), 'utf8'),
    publicOrigin: value.PATCHPAW_PUBLIC_ORIGIN,
    port: value.PATCHPAW_PORT,
    testRepo: value.PATCHPAW_GITHUB_TEST_REPO,
    operatorLogin: value.PATCHPAW_OPERATOR_GITHUB_LOGIN || undefined,
    adminToken: value.PATCHPAW_ADMIN_TOKEN || undefined,
    runtimeHome,
    legacyHome: value.PATCHPAW_LEGACY_HOME || undefined,
    paths,
    snapshotRoot: paths.snapshots,
  };
}
