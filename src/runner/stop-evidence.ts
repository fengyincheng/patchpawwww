import { Trace } from '../harness/trace.ts';
import { executionChanges } from './workspace-evidence.ts';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../workspace/git.ts';
import { readArtifact } from './review-lifecycle.ts';

const clip = (value: string, max = 1600) => value.length > max ? `${value.slice(0, max)}\n…完整证据保存在 run 中` : value;
export async function stopEvidence(dir: string, confirmedRemoteHead?: string) {
  const lines: string[] = [];
  const validation = await readArtifact(dir, 'last-validation.json');
  if (validation) {
    lines.push('### 最近一次候选代码验收');
    for (const t of validation.validation) {
      lines.push(`- ${t.exitCode === 0 && !t.timedOut ? '通过' : '失败'}：\`${t.command}\`（exit ${t.exitCode}${t.timedOut ? '，超时' : ''}）`);
      if (t.exitCode !== 0 || t.timedOut) {
        const output = `${t.stderr}\n${t.stdout}`;
        const start = output.search(/not ok|Error|error|Assertion/);
        lines.push(clip(start < 0 ? output.slice(-1000) : output.slice(start), 1000));
      } else {
        const totals = t.stdout.match(/^# (?:tests|pass|fail) .*/gm);
        if (totals) lines.push(totals.join('；'));
      }
    }
    if (validation.unmerged) lines.push('未解决的 Git 冲突：', clip(validation.unmerged));
    if (validation.failures?.length) lines.push('阻断项：', clip(validation.failures.join('\n')));
    if (validation.reason) lines.push(validation.reason);
    if (validation.warnings?.length) lines.push('格式检查提示（不阻断）：', clip(validation.warnings.join('\n')));
  } else lines.push('尚无已完成的候选代码验收记录。');
  lines.splice(0, lines.length, clip(lines.join('\n'), 3000));
  const manifest = await readArtifact(dir, 'manifest.json');
  const workspace = manifest?.workspace_path ?? join(dir, 'workspace');
  try { await access(join(workspace, '.git')); }
  catch { return `${lines.join('\n')}\n工作区尚未建立。`; }
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  const status = (await git(workspace, ['status', '--short'])).stdout.trim();
  const diff = manifest?.initial_head_sha ? (await git(workspace, ['diff', '--stat', manifest.initial_head_sha])).stdout : '';
  new Trace(dir).save('workspace-stop-state.json', { head, status, diff_stat: diff });
  const commits = manifest?.initial_head_sha ? (await git(workspace, ['log', '-5', '--oneline', `${manifest.initial_head_sha}..HEAD`])).stdout.trim() : '';
  if (manifest?.command === 'conflict') {
    lines.push(await executionChanges(workspace, dir), '### 当前合并工作区',
      `未解决冲突：${(await git(workspace, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean).length}`,
      '工作区状态包含 PR 与当前 main 合并产生的 A/D/R/M 条目，也可能包含先前执行保留的修改；不代表全部由本轮 Agent 编写。完整 Git 状态与差异证据保存在 run 中。');
  }
  lines.push('### 修改与发布状态', `本地 HEAD：\`${head}\``, `工作区：${status ? '仍有未提交修改\n' + clip(status) : '干净'}`,
    `最近确认的 GitHub head：${confirmedRemoteHead ?? '尚未确认'}`,
    head === confirmedRemoteHead ? '本地 HEAD 与最近确认的远端 head 一致。' : '本地 HEAD 尚无推送成功确认；不能当作已交付。');
  if (commits) lines.push('本地提交（最多列出 5 条，可能包含合入的主线历史）：', commits);
  if (manifest?.initial_head_sha) lines.push('相对 PR 初始 head 的整体差异（含合并带入的变化）：', clip(diff));
  return clip(lines.join('\n'), 6500);
}
