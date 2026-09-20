import type { Octokit } from '@octokit/rest';
import type { ReviewPayload } from '../tasks/review/result.ts';
import { mentionUsers } from './comments.ts';
import { ReviewStale } from '../scm/errors.ts';

export { ReviewStale } from '../scm/errors.ts';

export interface ReviewIdentity { runId: string; botLogin: string; allowLegacy?: boolean }
function reviewBody(sha: string, result: ReviewPayload, mentions: string[]) {
  if ('body' in result) return `## PatchPaw review\n\n${mentionUsers(mentions)}\n\nHead: \`${sha}\`\n\n${result.body}`;
  return `## PatchPaw P0 review\n\n${mentionUsers(mentions)}\n\nHead: \`${sha}\`\n\n${result.summary}\n\nRecommendation: **${result.recommendation}**\n\n`
    + result.findings.map(f => `- ${f.severity}: ${f.path}:${f.line} — ${f.title}\n  ${f.evidence}`).join('\n')
    + `\n\nLimitations: ${result.limitations.join('; ') || 'None reported'}`;
}

// Caller holds the per-PR worker lock. Normal runs and recovery use this same publisher.
export async function publishReview(client: Octokit, fullName: string, number: number, sha: string, result: ReviewPayload,
  mentions: string[], identity: ReviewIdentity, deliveryMarker?: string) {
  const [owner, repo] = fullName.split('/');
  const params = { owner, repo, pull_number: number };
  const assertFresh = async () => {
    const { data } = await client.rest.pulls.get(params);
    if (data.state !== 'open' || data.head.sha !== sha) throw new ReviewStale(sha, data.head.sha, data.state);
  };
  await assertFresh();
  const marker = `<!-- patchpaw:run=${identity.runId}:head=${sha}:kind=review -->`;
  const body = reviewBody(sha, result, mentions);
  const reviews = await client.paginate(client.rest.pulls.listReviews, { ...params, per_page: 100 });
  const own = reviews.filter(r => r.user?.type === 'Bot' && r.user.login.toLowerCase() === identity.botLogin.toLowerCase()
    && r.commit_id === sha && r.submitted_at && r.state !== 'PENDING');
  let existing = own.find(r => r.body?.includes(marker));
  if (!existing && identity.allowLegacy) {
    const legacy = own.filter(r => r.body?.startsWith('## PatchPaw P0 review') && !r.body.includes('<!-- patchpaw:run='));
    // Notification recipients may have changed since deployment. Compare all review content after Head.
    const content = (value: string) => value.slice(value.indexOf('Head: `')).replace(/\r\n/g, '\n').trim();
    existing = legacy.find(r => content(r.body) === content(body));
    if (!existing && legacy.length) throw new Error('Ambiguous legacy PatchPaw review on this head; refusing duplicate publication');
  }
  if (existing) return { id: existing.id, html_url: existing.html_url, commit_id: existing.commit_id,
    published_at: existing.submitted_at!, reused: true };
  await assertFresh(); // Listing may take time; recheck immediately before the write.
  // A COMMENT carries the structured recommendation without auto-approving a PR.
  const { data } = await client.rest.pulls.createReview({ ...params, commit_id: sha, event: 'COMMENT', body: `${body}\n\n${marker}${deliveryMarker ? `\n${deliveryMarker}` : ''}` });
  return { id: data.id, html_url: data.html_url, commit_id: data.commit_id,
    published_at: data.submitted_at ?? new Date().toISOString(), reused: false };
}
