import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configuredRuntimeHome, loadProjectEnvIfPresent, projectRoot } from '../src/config/env.ts';
import { loadOperation } from '../src/operation/load.ts';
import { contentDigest } from '../src/control-plane/common.ts';
import { openControlPlaneDb } from '../src/control-plane/db.ts';
import { copyPublicPrompt, listPrompts, updatePrompt } from '../src/control-plane/prompts.ts';
import { getRepository, listRepositories } from '../src/control-plane/repositories.ts';

// `operation/*.md` are bootstrap seeds only: bootstrapControlPlane returns an existing
// prompt asset untouched (see bootstrap.ts), so editing a seed never reaches a live
// control plane on its own. This script is the explicit bridge.
//
// Two layers with deliberately different rules:
//   public     - the global default. The seed file is authoritative, so a difference
//                means the file moved and the asset follows.
//   repository - the per-repository layer, and commands bind to it. A difference from
//                the global default is a customization, not staleness, so it must be
//                preserved. Telling the two apart needs a baseline: the content the copy
//                had when it last agreed with public. That is kept in control_plane_meta
//                under `operation_sync:repository:<repositoryId>:<slug>`. No branch below
//                ever overwrites a copy whose digest has moved off its baseline.
loadProjectEnvIfPresent();

const apply = process.argv.includes('--apply');
const checkOnly = process.argv.includes('--check');
const sourceRoot = join(projectRoot, 'operation');

function sourceSlugs() {
  return readdirSync(sourceRoot).filter(entry => entry.endsWith('.md')).map(entry => entry.slice(0, -3)).sort();
}

function sourceContent(slug: string) {
  try { return loadOperation(slug); }
  catch { return undefined; }
}

const baselineKey = (repositoryId: string, slug: string) => `operation_sync:repository:${repositoryId}:${slug}`;

const db = await openControlPlaneDb(configuredRuntimeHome());
const publicAssets = new Map((await listPrompts(db, { scope: 'public' })).map(asset => [asset.slug, asset]));
const notices: string[] = [];
const changes: string[] = [];
const preserved: string[] = [];

for (const slug of sourceSlugs()) {
  const source = sourceContent(slug);
  if (source === undefined) continue;
  const asset = publicAssets.get(slug);
  if (!asset) {
    notices.push(`operation/${slug}.md 在控制面没有对应资产：先运行 npm run bootstrap:control-plane 新建并绑定命令`);
    continue;
  }
  if (asset.content === source) continue;
  changes.push(`public/${slug}: rev${asset.revision} → rev${asset.revision + 1}（${asset.content.length} → ${source.length} 字符，源码优先）`);
  if (apply) await updatePrompt(db, asset.id, { content: source }, { expectedRevision: asset.revision });
}

for (const slug of publicAssets.keys()) {
  if (sourceContent(slug) === undefined) notices.push(`public/${slug} 在 operation/ 已无对应文件：本脚本不会删除资产，需要删除请在控制面显式操作`);
}

for (const repository of await listRepositories(db)) {
  const copies = new Map((await listPrompts(db, { scope: 'repository', repositoryId: repository.id })).map(asset => [asset.slug, asset]));
  for (const [slug, publicAsset] of publicAssets) {
    // Compare against the seed content, which is what the public asset holds once phase one
    // has run. Reading the public row again would be equivalent in apply mode but stale in
    // dry-run, so the desired state is derived from the source in both modes.
    const desired = sourceContent(slug);
    if (desired === undefined) continue;
    const copy = copies.get(slug);
    const where = `${repository.fullNameNormalized}/${slug}`;
    if (!copy) {
      notices.push(`${where} 缺少仓库副本：先运行 npm run bootstrap:control-plane`);
      continue;
    }
    const key = baselineKey(repository.id, slug);
    const baseline = await db.getMeta(key);
    const copyDigest = contentDigest(copy.content);

    // Already at the global default: nothing to do, and refresh the baseline so a copy that
    // was just refreshed from the UI counts as pristine from here on.
    if (copy.content === desired) {
      if (apply && baseline !== copyDigest) await db.setMeta(key, copyDigest);
      continue;
    }
    if (baseline !== undefined && copyDigest === baseline) {
      changes.push(`${where}: rev${copy.revision} → rev${copy.revision + 1}（落后于全局默认，跟随更新）`);
      if (!apply) continue;
      const fresh = await getRepository(db, repository.id);
      if (!fresh) { notices.push(`${repository.fullNameNormalized} 已不存在，跳过 ${slug}`); continue; }
      await copyPublicPrompt(db, repository.id, publicAsset.id, { replace: true, expectedRepositoryRevision: fresh.revision });
      await db.setMeta(key, contentDigest(desired));
      continue;
    }
    // Either the digest moved off the baseline (a customization) or there is no baseline
    // yet (provenance unknown). Both are preserved: this script never clobbers either.
    preserved.push(`${where}: rev${copy.revision}${baseline === undefined ? '（无基线，来源不明）' : ''}`);
    if (apply && baseline === undefined) await db.setMeta(key, copyDigest);
  }
}

if (changes.length) {
  console.log(`operation/ → 控制面 待同步 ${changes.length} 项${apply ? '（本次已写入）' : '（空跑，加 --apply 写入）'}：`);
  for (const change of changes) console.log(`  ${change}`);
} else {
  console.log('operation/ 与控制面已一致，无需同步。');
}
if (preserved.length) {
  console.log(`保留未动的仓库定制 ${preserved.length} 项（不覆盖；如需重置为全局默认，请在控制面用「替换」）：`);
  for (const item of preserved) console.log(`  ${item}`);
}
for (const notice of notices) console.log(`  注意：${notice}`);
console.log(`合计：变更 ${changes.length} 项，保留 ${preserved.length} 项，提示 ${notices.length} 项，模式 ${apply ? 'apply' : 'dry-run'}`);

if (checkOnly && changes.length) process.exit(1);
