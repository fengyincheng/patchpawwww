import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { RunFailure } from '../runner/failures.ts';

const commentEvent = z.object({
  action: z.literal('created'),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  issue: z.object({ number: z.number().int().positive(), pull_request: z.object({}) }),
  comment: z.object({ id: z.number().int().positive(), body: z.string(), html_url: z.url(),
    author_association: z.string(), created_at: z.string().optional(), user: z.object({ login: z.string(), type: z.string() }) }),
});

export function humanReply(payload: unknown, botLogin: string, sourceEventId?: string) {
  const parsed = commentEvent.safeParse(payload);
  if (!parsed.success) return null;
  const { repository, installation, issue, comment } = parsed.data;
  const login = botLogin.replace(/\[bot\]$/i, "");
  const mention = new RegExp(`(^|\\s)@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\[bot\\])?(?=$|[\\s:,.!?，。！？：])`, 'i');
  // Let an unqualified author reach the durable rejection path only for the exact executable
  // control form. Quoted or ordinary discussion that merely contains "/approval" remains a
  // normal ignored chatter event and cannot wake a worker.
  const approvalMention = new RegExp(`^[\\t ]*@${login.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?:\\[bot\\])?\\s+\\/(?:approval|approve)(?=$|\\s)`, 'i').test(comment.body);
  if (comment.user.type === 'Bot' || !mention.test(comment.body)
    || (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association) && !approvalMention)) return null;
  return { repo: repository.full_name, pr_number: issue.number, installation_id: installation.id,
    comment_id: comment.id, author: comment.user.login, body: comment.body, url: comment.html_url,
    author_association: comment.author_association, ...(comment.created_at ? { created_at: comment.created_at } : {}),
    ...(sourceEventId ? { source_event_id: sourceEventId } : {}) };
}
export type HumanReply = Omit<NonNullable<ReturnType<typeof humanReply>>, 'installation_id' | 'author_association' | 'source_event_id'> & {
  installation_id?: number;
  /** Preserved from the signed webhook; legacy local inbox records may omit it. */
  author_association?: string;
  /** GitHub delivery identity, when the comment entered through the webhook. */
  source_event_id?: string;
  /** GitHub comment creation time, used to reject an approval that predates a newer proposal. */
  created_at?: string;
  /** SCM metadata is populated for GitLab comments; GitHub records retain the legacy shape. */
  platform?: 'github' | 'gitlab';
  connection_id?: string;
  project_id?: string;
  author_id?: string;
  repository_path?: string;
};

export function mentionUsers(users: (string | undefined)[]) {
  const unique = new Map<string, string>();
  for (const user of users) if (user) unique.set(user.toLowerCase(), user);
  return [...unique.values()].map(user => `@${user}`).join(' ');
}

export async function publishPRReply(client: Octokit, fullName: string, number: number, body: string, mentions: string[]) {
  const [owner, repo] = fullName.split('/');
  const { data } = await client.rest.issues.createComment({ owner, repo, issue_number: number,
    body: `${mentionUsers(mentions)}\n\n${body}`.trim() });
  return { id: data.id, html_url: data.html_url };
}

export interface RunNotice {
  run_id: string; head: string; status: string; phase: string; reason: string; mentions: string[]; bot_login?: string; failure?: RunFailure;
}

const failureTitles: Record<string, string> = {
  provider_upstream_unavailable: '模型服务暂时不可用',
  provider_auth_failed: '模型服务认证失败',
  provider_request_rejected: '模型服务拒绝了请求',
  provider_configuration_error: '模型 Provider 配置不可用',
  provider_protocol_error: '模型服务返回格式异常',
  model_output_truncated: '模型输出被截断，尚未完成',
  github_unavailable: 'GitHub 服务暂时不可用',
  internal_error: 'PatchPaw 内部错误',
};

function failureDetails(failure: RunFailure) {
  return [
    `失败代码：\`${failure.code}\``,
    failure.category === 'provider' ? '这是模型服务或 Provider 基础设施故障，不等同于 PR 代码测试失败。'
      : failure.category === 'github' ? '这是 GitHub 通信故障，不等同于 PR 代码测试失败。' : undefined,
    `原因：${failure.message}`,
    failure.upstream_status === undefined ? undefined : `上游状态：HTTP ${failure.upstream_status}`,
    failure.upstream_code === undefined ? undefined : `上游错误码：\`${failure.upstream_code}\``,
    failure.attempts === undefined ? undefined : `Provider 请求尝试：${failure.attempts} 次`,
    `是否可重试：${failure.retryable ? '可以' : '不建议自动重试'}`,
    `下一步：${failure.user_action === 'retry' ? '稍后重新发送原命令' : failure.user_action === 'check_configuration' ? '检查 Provider 凭据和配置' : failure.user_action === 'human_review' ? '请人工检查当前状态' : '查看 Run trace 后再决定下一步'}`,
  ].filter((line): line is string => !!line).join('\n');
}

export function runNoticeBody(notice: RunNotice, includeCloseoutMarker = true) {
  const title = notice.failure ? failureTitles[notice.failure.code] ?? '任务执行失败'
    : notice.status === 'stopped' ? '已按 /stop 暂停，等待沟通' : notice.status === 'needs_human' ? '需要人工答复' : notice.status === 'budget_exhausted' ? '本轮执行预算已用完，候选修复尚未完成' : notice.status === 'model_output_truncated' ? '模型输出被截断，尚未完成' : '任务停止，尚未完成';
  const instruction = notice.failure?.user_action === 'retry' || notice.status === 'model_output_truncated'
    ? '请在此 PR 新增评论，@ 本条评论的机器人，并使用原请求的 `/readme` 重新执行；无需改用 `/review`。同一 PR 保留对话记忆。'
    : '请在此 PR 新增评论，@ 本条评论的机器人，并写下你的答复或处理要求。'
      + '可以直接提问或讨论；继续执行任务请在 @ 后使用 /conflict、/review 、/CI 或 /stop，每条评论一个命令。同一 PR 保留对话记忆；/conflict 在 Git 状态兼容且工作区可安全接管时继续因预算或人工决策暂停的候选。';
  return `## PatchPaw：${title}\n\n`
    + `Run: \`${notice.run_id}\` · Head: \`${notice.head || '未获取'}\`\n\n`
    + `阶段：\`${notice.phase}\` · 状态：\`${notice.status}\`\n\n${notice.failure ? `${failureDetails(notice.failure)}\n\n` : ''}${notice.reason}\n\n`
    + instruction
    + '\n\n不要在评论中粘贴密钥。'
    + (includeCloseoutMarker && ['budget_exhausted', 'stopped'].includes(notice.status) ? `\n\n<!-- patchpaw-budget-closeout:${notice.run_id} -->` : '');
}
export async function publishRunNotice(client: Octokit, fullName: string, number: number, notice: RunNotice) {
  const [owner, repo] = fullName.split('/');
  const body = `${mentionUsers(notice.mentions)}\n\n${runNoticeBody(notice)}`.trim();
  const { data } = await client.rest.issues.createComment({ owner, repo, issue_number: number, body });
  return { id: data.id, html_url: data.html_url };
}
