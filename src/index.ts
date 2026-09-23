import { loadConfig, projectRoot } from './config/env.ts';
import { dispatchHumanReply } from './runner/dispatch.ts';
import { createGitHub } from './github/client.ts';
import { buildServer } from './server/app.ts';
import { startCommunicationScheduler } from './runner/communication-scheduler.ts';
import { GitLabClient } from './scm/gitlab/client.ts';
import { GitLabAdapter } from './scm/gitlab/adapter.ts';
import type { ScmConnection } from './scm/types.ts';
import { listScmConnections, openControlPlaneDb } from './control-plane/index.ts';
import { SecretStore } from './control-plane/secrets.ts';

type GitLabRuntimeConnection = { id: string; instanceUrl: string; projectIds: string[]; token?: string; webhookMode: 'secret' | 'signing'; webhookSecret?: string; botUserId?: string; botLogin?: string; connection: ScmConnection };

async function loadGitLabConnections(config: ReturnType<typeof loadConfig>): Promise<GitLabRuntimeConnection[]> {
  const byId = new Map<string, GitLabRuntimeConnection>();
  for (const value of config.gitlabConnections) {
    const connection: ScmConnection = { id: value.id, kind: 'gitlab', instanceUrl: value.instanceUrl, credentialRef: null, webhookMode: value.webhookMode,
      webhookSecretRef: null, botUserId: value.botUserId ?? null, botLogin: value.botLogin ?? null, projectIds: value.projectIds, enabled: true, createdAt: '', updatedAt: '' };
    byId.set(value.id, { ...value, connection });
  }
  const db = await openControlPlaneDb(config.runtimeHome);
  try {
    const secrets = new SecretStore(config.runtimeHome);
    for (const connection of await listScmConnections(db)) {
      if (!connection.enabled || connection.kind !== 'gitlab' || byId.has(connection.id) || !connection.credentialRef || !connection.webhookSecretRef) continue;
      if (!await secrets.isConfigured(connection.credentialRef) || !await secrets.isConfigured(connection.webhookSecretRef)) continue;
      byId.set(connection.id, { id: connection.id, instanceUrl: connection.instanceUrl, projectIds: connection.projectIds,
        token: await secrets.read(connection.credentialRef), webhookMode: connection.webhookMode, webhookSecret: await secrets.read(connection.webhookSecretRef),
        botUserId: connection.botUserId ?? undefined, botLogin: connection.botLogin ?? undefined, connection });
    }
  } finally { db.close(); }
  return [...byId.values()];
}

let communication: ReturnType<typeof startCommunicationScheduler> | undefined;
try {
  const config = loadConfig();
  const runtimeHome = config.runtimeHome;
  const github = config.githubConfigured ? createGitHub(config) : undefined;
  const configuredGitLabConnections = await loadGitLabConnections(config);
  const gitlabAdapters = new Map<string, GitLabAdapter>();
  const gitlabWebhooks = [] as Array<{
    connectionId: string; projectIds: string[]; webhookMode: 'secret' | 'signing'; webhookSecret: string;
    botUserId?: string; botLogin?: string; resolveBotIdentity: () => Promise<{ id: string; login: string }>; reader: GitLabAdapter;
  }>;
  for (const value of configuredGitLabConnections.filter(value => value.token && value.webhookSecret)) {
    const client = new GitLabClient({ baseUrl: value.instanceUrl, token: value.token! });
    const { data: user } = await client.user();
    const detectedBotUserId = user.id === undefined ? undefined : String(user.id);
    const detectedBotLogin = typeof user.username === 'string' ? user.username : undefined;
    if (!detectedBotUserId || !detectedBotLogin) throw new Error(`GitLab connection ${value.id} has no usable Bot identity`);
    if (value.botUserId && value.botUserId !== detectedBotUserId || value.botLogin && value.botLogin.toLowerCase() !== detectedBotLogin.toLowerCase()) {
      throw new Error(`GitLab connection ${value.id} has stale Bot identity configuration`);
    }
    const botUserId = detectedBotUserId;
    const botLogin = detectedBotLogin;
    const connection: ScmConnection = { ...value.connection, botUserId: botUserId ?? null, botLogin: botLogin ?? null };
    const adapter = new GitLabAdapter(connection, client, { id: botUserId, username: botLogin });
    gitlabAdapters.set(value.id, adapter);
    gitlabWebhooks.push({ connectionId: value.id, projectIds: value.projectIds, webhookMode: value.webhookMode, webhookSecret: value.webhookSecret!, botUserId, botLogin, resolveBotIdentity: async () => {
      const { data: user } = await adapter.client.user();
      const id = user.id === undefined ? '' : String(user.id);
      const login = String(user.username ?? '');
      if (!id || !login) throw new Error('GitLab bot identity is incomplete');
      return { id, login };
    }, reader: adapter });
  }
  communication = startCommunicationScheduler({ ...config, root: runtimeHome,
    inboundScmReader: connectionId => gitlabAdapters.get(connectionId),
    connectionFor: async item => {
      const match = item.repo.match(/^gitlab:(.+):project:/);
      const adapter = match ? gitlabAdapters.get(match[1]) : undefined;
      if (adapter) return { adapter, botLogin: adapter.botLogin };
      if (!github) throw new Error('No SCM connection is configured for this delivery');
      const [owner, repo] = item.repo.split('/');
      const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo });
      return { client: github.installation(installation.id), botLogin: config.botLogin };
    },
  }, github,
    comment => dispatchHumanReply(runtimeHome, comment, projectRoot));
  await communication.ready;
  const app = buildServer({ ...config, root: runtimeHome, botLogin: config.botLogin, gitlabWebhooks }, github, true,
    comment => dispatchHumanReply(runtimeHome, comment, projectRoot));
  await app.listen({ host: config.listenHost, port: config.port });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { communication?.stop(); void app.close(); });
  }
} catch (error) {
  communication?.stop();
  // Avoid dumping SDK/config objects containing credentials.
  console.error(JSON.stringify({ status: 'startup_failed', code: (error as NodeJS.ErrnoException).code ?? 'CONFIG_OR_STARTUP' }));
  process.exitCode = 1;
}
