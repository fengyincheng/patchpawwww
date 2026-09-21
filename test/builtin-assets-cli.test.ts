import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('builtin asset migration CLI is dry-run by default and applies only on --apply', async () => {
  const source = await readFile(join(process.cwd(), 'scripts/migrate-builtin-assets.ts'), 'utf8');
  assert.match(source, /const apply = process\.argv\.includes\('--apply'\)/);
  assert.match(source, /runBuiltinAssetMigrations\(db\)/);
  assert.match(source, /mode: 'dry-run'/);
});

test('builtin migration stays separate from operator-owned Prompt sync', async () => {
  const source = await readFile(join(process.cwd(), 'scripts/migrate-builtin-assets.ts'), 'utf8');
  assert.doesNotMatch(source, /sync-operation-prompts\.ts|['"]sync:operation['"]/);
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(packageJson.scripts['migrate:builtin-assets'], /migrate-builtin-assets\.ts/);
  assert.equal(packageJson.scripts['migrate:builtin-assets'].includes('--apply'), false);
  assert.match(packageJson.scripts['sync:operation'], /sync-operation-prompts\.ts/);
  assert.equal(packageJson.scripts['sync:operation'].includes('--apply'), false);
});

test('builtin migration CLI reports contradictory ownership as a failure', async () => {
  const source = await readFile(join(process.cwd(), 'scripts/migrate-builtin-assets.ts'), 'utf8');
  assert.match(source, /status: 'builtin_migration_failed'/);
  assert.match(source, /process\.exitCode = 1/);
});
