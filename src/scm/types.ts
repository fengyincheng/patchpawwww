import type { ReviewPayload } from '../tasks/review/result.ts';

export const SCM_KINDS = ['github', 'gitlab'] as const;
export type ScmKind = typeof SCM_KINDS[number];

export interface ScmConnection {
  id: string;
  kind: ScmKind;
  instanceUrl: string;
  credentialRef: string | null;
  webhookMode: 'secret' | 'signing';
  webhookSecretRef: string | null;
  botUserId: string | null;
  botLogin: string | null;
  projectIds: string[];
  enabled: boolean;
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryRef {
  id?: string;
  connectionId: string;
  kind: ScmKind;
  remoteProjectId: string;
  pathWithNamespace: string;
  webUrl: string;
  cloneUrl: string;
  storageKey: string;
}

export interface ChangeRequestRef {
  repository: RepositoryRef;
  number: number;
  webUrl: string;
}

export interface ChangeRequestSnapshot {
  schemaVersion: 1;
  kind: ScmKind;
  repository: RepositoryRef;
  changeRequest: ChangeRequestRef;
  source: { projectId: string; pathWithNamespace: string; ref: string; sha: string; cloneUrl?: string };
  target: { projectId: string; pathWithNamespace: string; ref: string; sha: string };
  diffBaseSha: string | null;
  state: string;
  title: string;
  body: string;
  author: { id: string | null; login: string };
  receivedAt: string;
  sourceEventId?: string;
}

export interface InboundScmComment {
  platform: ScmKind;
  connectionId: string;
  projectId: string;
  storageKey: string;
  repositoryPath: string;
  changeRequestNumber: number;
  remoteId: number;
  authorId: string;
  authorLogin: string;
  body: string;
  url: string;
  createdAt?: string;
  sourceEventId: string;
}

export interface ActorAuthorization {
  platform: ScmKind;
  actorId: string;
  checkedAt: string;
  accessLevel: number | null;
  source: string;
  canExecute: boolean;
  canApprove: boolean;
}

export type CiState = 'pending' | 'green' | 'red' | 'unknown';

export interface ScmCiItem {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  pipelineId?: string;
  jobId?: string;
  sha?: string;
  allowFailure?: boolean;
  log?: string;
  logErrorStatus?: number | null;
}

export interface ScmCiState {
  sha: string;
  state: CiState;
  items: ScmCiItem[];
  evidence: { projectId?: string; pipelineId?: string; source?: string; targetSha?: string }[];
}

export interface ScmDeliveryReceipt {
  id: number;
  htmlUrl: string;
  commitId?: string;
  publishedAt: string;
  reused: boolean;
  remoteAdopted?: boolean;
}

export interface ScmAdapter {
  readonly kind: ScmKind;
  readonly connection: ScmConnection;
  readonly botLogin: string;
  readonly botUserId?: string;
  readChangeRequest(projectId: string, number: number, options?: { allowClosed?: boolean }): Promise<ChangeRequestSnapshot>;
  verifyInboundComment(comment: InboundScmComment): Promise<ActorAuthorization>;
  listComments(projectId: string, number: number): Promise<Array<{ id: number; author: string; authorId: string; body: string; url: string; createdAt?: string; system?: boolean }>>;
  publishComment(projectId: string, number: number, body: string, markers: string[]): Promise<ScmDeliveryReceipt>;
  publishReview(projectId: string, number: number, headSha: string, review: ReviewPayload, mentions: string[], marker: string): Promise<ScmDeliveryReceipt>;
  readCI(projectId: string, number: number, sha: string): Promise<ScmCiState>;
  failureEvidence(projectId: string, ci: ScmCiState): Promise<unknown>;
  installationGitToken?(): Promise<string>;
}

export interface ScmInboundReader {
  verifyInboundComment(comment: InboundScmComment): Promise<ActorAuthorization>;
}
