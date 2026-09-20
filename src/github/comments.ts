import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { runNoticeBody, type RunNotice } from '../runner/run-notice.ts';
import type { HumanReply as NormalizedHumanReply } from '../runner/human-reply.ts';

// Kept as a compatibility export while the formatter is shared by GitHub and GitLab.
export { runNoticeBody } from '../runner/run-notice.ts';
export type { RunNotice } from '../runner/run-notice.ts';

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
/** Compatibility export for webhook callers; shared lifecycle code uses the normalized type. */
export type HumanReply = NormalizedHumanReply;

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

export async function publishRunNotice(client: Octokit, fullName: string, number: number, notice: RunNotice) {
  const [owner, repo] = fullName.split('/');
  const body = `${mentionUsers(notice.mentions)}\n\n${runNoticeBody(notice)}`.trim();
  const { data } = await client.rest.issues.createComment({ owner, repo, issue_number: number, body });
  return { id: data.id, html_url: data.html_url };
}
