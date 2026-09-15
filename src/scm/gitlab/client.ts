import { normalizeInstanceUrl, encodeProjectId } from '../identity.ts';

export interface GitLabClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPages?: number;
}

export class GitLabHttpError extends Error {
  readonly retryAfter?: number;
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message); this.name = 'GitLabHttpError';
    this.retryAfter = retryAfterMs === undefined ? undefined : retryAfterMs / 1000;
  }
}

function retryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function linkNext(value: string | null) {
  if (!value) return undefined;
  const match = value.split(',').map(part => part.trim()).find(part => /rel="?next"?/i.test(part));
  const target = match?.match(/<([^>]+)>/)?.[1];
  return target;
}

export class GitLabClient {
  readonly instanceUrl: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  constructor(private readonly options: GitLabClientOptions) {
    this.instanceUrl = normalizeInstanceUrl(options.baseUrl);
    this.baseUrl = `${this.instanceUrl}/api/v4`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxPages = options.maxPages ?? 100;
    if (!options.token.trim()) throw new Error('GitLab token is required');
  }

  get token() { return this.options.token; }

  assertRemoteUrl(remoteUrl: string) {
    const target = new URL(remoteUrl);
    const base = new URL(this.instanceUrl);
    const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
    const sameInstancePath = !basePath || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin || !sameInstancePath || target.username || target.password || target.search || target.hash) {
      throw new Error('GitLab repository URL crossed the configured instance');
    }
    return target.toString();
  }

  private url(path: string) {
    if (/^https?:\/\//i.test(path)) {
      const target = new URL(path);
      const base = new URL(this.baseUrl);
      if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}/`) || target.username || target.password || target.hash) throw new Error('GitLab pagination crossed the configured instance');
      return target;
    }
    return new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<{ data: T; response: Response }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const headers = new Headers(init.headers);
    headers.set('PRIVATE-TOKEN', this.options.token);
    headers.set('accept', headers.get('accept') ?? 'application/json');
    let response: Response;
    try { response = await this.fetchImpl(this.url(path), { ...init, redirect: 'manual', headers, signal }); }
    catch (error) { throw Object.assign(new Error('GitLab request failed'), { cause: error, code: 'GITLAB_NETWORK_ERROR', retryable: true }); }
    finally { clearTimeout(timer); }
    if (response.status >= 300 && response.status < 400) throw new GitLabHttpError(response.status, 'GitLab refused a redirected API request');
    if (!response.ok) {
      throw new GitLabHttpError(response.status, `GitLab API request failed (${response.status})`, retryAfter(response.headers.get('retry-after')));
    }
    const text = await response.text();
    if (!text) return { data: undefined as T, response };
    if (headers.get('accept')?.includes('text/plain')) return { data: text as T, response };
    try { return { data: JSON.parse(text) as T, response }; }
    catch { throw new GitLabHttpError(502, 'GitLab API returned invalid JSON'); }
  }

  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>) {
    const url = this.url(path);
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.request<T>(url.toString());
  }

  async all<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const requestParams = { per_page: 100, ...params };
    const first = await this.get<T[]>(path, requestParams);
    const result = [...(first.data ?? [])];
    const nextPage = first.response.headers.get('x-next-page');
    let next: URL | undefined;
    if (nextPage) {
      next = this.url(path);
      for (const [key, value] of Object.entries(requestParams)) if (value !== undefined) next.searchParams.set(key, String(value));
      next.searchParams.set('page', nextPage);
    } else {
      const link = linkNext(first.response.headers.get('link'));
      next = link ? this.url(link) : undefined;
    }
    let pages = 1;
    while (next && pages < this.maxPages) {
      const current = await this.request<T[]>(next.toString());
      result.push(...(current.data ?? []));
      const headerNext = current.response.headers.get('x-next-page');
      if (headerNext) next.searchParams.set('page', headerNext);
      else {
        const link = linkNext(current.response.headers.get('link'));
        next = link ? this.url(link) : undefined;
      }
      pages++;
    }
    if (next) throw new GitLabHttpError(502, 'GitLab pagination exceeded the safety limit');
    return result;
  }

  projectPath(projectId: string | number) { return `/projects/${encodeProjectId(projectId)}`; }
  project(projectId: string | number) { return this.get<Record<string, any>>(this.projectPath(projectId)); }
  user() { return this.get<Record<string, any>>('/user'); }
  mergeRequest(projectId: string | number, iid: number) { return this.get<Record<string, any>>(`${this.projectPath(projectId)}/merge_requests/${iid}`); }
  note(projectId: string | number, iid: number, noteId: number) { return this.get<Record<string, any>>(`${this.projectPath(projectId)}/merge_requests/${iid}/notes/${noteId}`); }
  notes(projectId: string | number, iid: number, params: Record<string, string | number | boolean | undefined> = {}) { return this.all<Record<string, any>>(`${this.projectPath(projectId)}/merge_requests/${iid}/notes`, params); }
  async createNote(projectId: string | number, iid: number, body: string) {
    return this.request<Record<string, any>>(`${this.projectPath(projectId)}/merge_requests/${iid}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
  }
  members(projectId: string | number, userId: string | number) { return this.get<Record<string, any>>(`${this.projectPath(projectId)}/members/all/${encodeProjectId(userId)}`); }
  pipelines(projectId: string | number, params: Record<string, string | number | boolean | undefined> = {}) { return this.all<Record<string, any>>(`${this.projectPath(projectId)}/pipelines`, params); }
  mergeRequestPipelines(projectId: string | number, iid: number) { return this.all<Record<string, any>>(`${this.projectPath(projectId)}/merge_requests/${iid}/pipelines`); }
  jobs(projectId: string | number, pipelineId: string | number) { return this.all<Record<string, any>>(`${this.projectPath(projectId)}/pipelines/${pipelineId}/jobs`, { include_retried: false }); }
  trace(projectId: string | number, jobId: string | number) { return this.request<string>(`${this.projectPath(projectId)}/jobs/${jobId}/trace`, { headers: { accept: 'text/plain' } }); }
  branch(projectId: string | number, ref: string) { return this.get<Record<string, any>>(`${this.projectPath(projectId)}/repository/branches/${encodeURIComponent(ref)}`); }
}

export function escapeGitLabQuickActions(body: string) {
  return body.replace(/(^|\n)([\t ]*)\/(?![\s/])/g, '$1$2\u200b/');
}
