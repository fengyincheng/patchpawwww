import type { RunFailure, ScmPlatform } from './failures.ts';

/** The platform-neutral durable notice persisted alongside a run result. */
export interface RunNotice {
  run_id: string;
  head: string;
  status: string;
  phase: string;
  reason: string;
  mentions: string[];
  bot_login?: string;
  platform?: ScmPlatform;
  failure?: RunFailure;
}

export const failureTitles: Record<string, string> = {
  provider_upstream_unavailable: '模型服务暂时不可用',
  provider_auth_failed: '模型服务认证失败',
  provider_request_rejected: '模型服务拒绝了请求',
  provider_configuration_error: '模型 Provider 配置不可用',
  provider_protocol_error: '模型服务返回格式异常',
  model_output_truncated: '模型输出被截断，尚未完成',
  github_unavailable: 'GitHub 服务暂时不可用',
  gitlab_auth_failed: 'GitLab 认证失败',
  gitlab_configuration_error: 'GitLab 连接配置错误',
  gitlab_unavailable: 'GitLab 服务暂时不可用',
  gitlab_request_rejected: 'GitLab 拒绝了请求',
  gitlab_protocol_error: 'GitLab 服务返回格式异常',
  internal_error: 'PatchPaw 内部错误',
};

function targetFor(notice: RunNotice) {
  const platform = notice.platform ?? notice.failure?.scm_platform ?? 'github';
  return platform === 'gitlab' ? 'MR' : 'PR';
}

function failureDetails(failure: RunFailure) {
  const scm = failure.category === 'scm';
  const platform = failure.scm_platform === 'gitlab' ? 'GitLab' : failure.scm_platform === 'github' ? 'GitHub' : 'SCM';
  const nextAction = failure.user_action === 'retry' ? '稍后重新发送原命令'
    : failure.user_action === 'check_configuration'
      ? failure.scm_platform === 'gitlab' ? '检查 GitLab token、连接配置、项目绑定和 Bot identity 配置' : failure.scm_platform === 'github' ? '检查 GitHub App 配置' : '检查 Provider 凭据和配置'
      : failure.user_action === 'human_review' ? '请人工检查当前状态' : '查看 Run trace 后再决定下一步';
  return [
    `失败代码：\`${failure.code}\``,
    failure.category === 'provider' ? '这是模型服务或 Provider 基础设施故障，不等同于代码测试失败。'
      : scm ? `这是 ${platform} 通信故障，不等同于代码测试失败。` : undefined,
    `原因：${failure.message}`,
    failure.upstream_status === undefined ? undefined : `上游状态：HTTP ${failure.upstream_status}`,
    failure.upstream_code === undefined ? undefined : `上游错误码：\`${failure.upstream_code}\``,
    failure.attempts === undefined ? undefined : `Provider 请求尝试：${failure.attempts} 次`,
    `是否可重试：${failure.retryable ? '可以' : '不建议自动重试'}`,
    `下一步：${nextAction}`,
  ].filter((line): line is string => !!line).join('\n');
}

export function runNoticeBody(notice: RunNotice, includeCloseoutMarker = true) {
  const target = targetFor(notice);
  const title = notice.failure ? failureTitles[notice.failure.code] ?? '任务执行失败'
    : notice.status === 'stopped' ? '已按 /stop 暂停，等待沟通' : notice.status === 'needs_human' ? '需要人工答复' : notice.status === 'budget_exhausted' ? '本轮执行预算已用完，候选修复尚未完成' : notice.status === 'model_output_truncated' ? '模型输出被截断，尚未完成' : '任务停止，尚未完成';
  const instruction = notice.failure?.user_action === 'retry' || notice.status === 'model_output_truncated'
    ? `请在此 ${target} 新增评论，@ 本条评论的机器人，并使用原请求的 \`/readme\` 重新执行；无需改用 \`/review\`。同一 ${target} 保留对话记忆。`
    : `请在此 ${target} 新增评论，@ 本条评论的机器人，并写下你的答复或处理要求。`
      + `可以直接提问或讨论；继续执行任务请在 @ 后使用 /conflict、/review 、/CI 或 /stop，每条评论一个命令。同一 ${target} 保留对话记忆；/conflict 在 Git 状态兼容且工作区可安全接管时继续因预算或人工决策暂停的候选。`;
  return `## PatchPaw：${title}\n\n`
    + `Run: \`${notice.run_id}\` · Head: \`${notice.head || '未获取'}\`\n\n`
    + `阶段：\`${notice.phase}\` · 状态：\`${notice.status}\`\n\n${notice.failure ? `${failureDetails(notice.failure)}\n\n` : ''}${notice.reason}\n\n`
    + instruction
    + '\n\n不要在评论中粘贴密钥。'
    + (includeCloseoutMarker && ['budget_exhausted', 'stopped'].includes(notice.status) ? `\n\n<!-- patchpaw-budget-closeout:${notice.run_id} -->` : '');
}
