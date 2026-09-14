import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { verifySignature } from '../github/webhook.ts';
import type { GitHubReader } from '../github/client.ts';
import { normalizeSnapshot, saveSnapshot, saveVerification, verifySnapshot, supportedActions } from '../github/snapshot.ts';
import { humanReply, type HumanReply } from '../github/comments.ts';
import { persistInboundComment } from '../runner/inbound-verification.ts';
import { configuredRuntimeHome } from '../config/env.ts';
import { registerAdminApi } from './admin-api.ts';
import { withRuntimeLock } from '../migration/runtime-lock.ts';
import { publicSetupInfo } from './public-setup.ts';

export interface ServerConfig {
  webhookSecret: string;
  snapshotRoot: string;
  testRepo: string;
  botLogin?: string;
  root?: string;
  publicOrigin?: string;
  adminToken?: string;
  bootstrapEnv?: NodeJS.ProcessEnv;
}
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const frontendDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

const frontendContentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function buildServer(config: ServerConfig, github: GitHubReader, logger = false,
  onComment?: (comment: HumanReply) => Promise<void>) {
  const app = Fastify({ logger, bodyLimit: 25 * 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const health = () => ({ service: 'patchpaw', status: 'ok', version, time: new Date().toISOString() });
  app.get('/health', health);
  app.get('/api/setup', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.send({ data: publicSetupInfo(config.publicOrigin, Boolean(config.adminToken)) });
  });
  registerAdminApi(app, { root: config.root ?? configuredRuntimeHome(), publicOrigin: config.publicOrigin,
    adminToken: config.adminToken, bootstrapEnv: config.bootstrapEnv }, github);

  app.post<{ Body: Buffer }>('/github/webhook', async (request, reply) => {
    const header = (name: string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : undefined;
    const event = header('x-github-event');
    const delivery = header('x-github-delivery');
    request.log.info({ event, delivery_id: delivery, status: 'received' });
    if (!Buffer.isBuffer(request.body) || !verifySignature(request.body, header('x-hub-signature-256'), config.webhookSecret)) {
      return reply.code(401).send({ status: 'invalid_signature' });
    }
    if (!event || !delivery || !/^[a-zA-Z0-9-]+$/.test(delivery)) {
      return reply.code(400).send({ status: 'invalid_headers' });
    }
    let payload: unknown;
    try { payload = JSON.parse(request.body.toString('utf8')); }
    catch { return reply.code(400).send({ status: 'invalid_json' }); }
    if (event === 'issue_comment' && config.botLogin && onComment) {
      const comment = humanReply(payload, config.botLogin, delivery);
      if (!comment) return { status: 'ignored', event };
      try {
        // Persist the signed, normalized comment before the remote installation read. The
        // verification result is never inferred from the webhook alone, but a transient GitHub
        // outage can no longer erase the human's message before it enters durable storage.
        const stored = await withRuntimeLock(config.root ?? config.snapshotRoot, 'shared', false,
          () => persistInboundComment(config.root ?? config.snapshotRoot, delivery, comment));
        // Verification and worker dispatch belong to the deadline-driven communication
        // scheduler. The webhook only acknowledges after the signed normalized comment is
        // durable; GitHub availability cannot make a human message disappear.
        return reply.code(202).send({ status: 'verification_pending', delivery_id: delivery, comment_id: comment.comment_id,
          duplicate: stored.record.status !== 'pending_verification' });
      } catch (error) {
        request.log.error({ event, delivery_id: delivery, status: 'comment_processing_failed',
          http_status: (error as { status?: number }).status ?? null });
        return reply.code(502).send({ status: 'processing_failed', delivery_id: delivery });
      }
    }
    const action = (payload as { action?: unknown } | null)?.action;
    if (event !== 'pull_request' || !supportedActions.some(supported => supported === action)) {
      request.log.info({ event, delivery_id: delivery, status: 'ignored' });
      return { status: 'ignored', event, delivery_id: delivery };
    }
    let snapshot;
    try { snapshot = normalizeSnapshot(payload, delivery, new Date().toISOString()); }
    catch { return reply.code(400).send({ status: 'invalid_payload', delivery_id: delivery }); }
    if (snapshot.repository.full_name.toLowerCase() !== config.testRepo.toLowerCase()) {
      request.log.info({ event, delivery_id: delivery, status: 'ignored', reason: 'outside_phase_1_repo' });
      return { status: 'ignored', reason: 'outside_phase_1_repo', delivery_id: delivery };
    }
    return withRuntimeLock(config.root ?? config.snapshotRoot, 'shared', false, async () => {
      let saved;
      try {
        saved = await saveSnapshot(config.snapshotRoot, snapshot);
        const verification = await verifySnapshot(saved.snapshot, github);
        await saveVerification(saved.path, verification);
        // Passive events retain historical lab snapshots only. They never dispatch an agent.
        request.log.info({ event, action, delivery_id: delivery, installation_id: saved.snapshot.installation_id,
          status: 'snapshot_saved', verification: verification.status, duplicate: saved.duplicate });
        return { status: 'snapshot_saved', delivery_id: delivery, verification: verification.status, duplicate: saved.duplicate };
      } catch (error) {
        const failure = { status: 'processing_failed', checked_at: new Date().toISOString(),
          http_status: (error as { status?: number }).status ?? null,
          code: (error as NodeJS.ErrnoException).code ?? null };
        // Never serialize the SDK error: it may carry authorization headers.
        request.log.error({ event, delivery_id: delivery, ...failure });
        if (saved) await saveVerification(saved.path, failure).catch(() => {});
        return reply.code(502).send({ status: 'processing_failed', delivery_id: delivery });
      }
    });
  });

  const serveFrontend = async (request: { url: string }, reply: FastifyReply) => {
    if (!existsSync(frontendDist)) return reply.code(503).send({ status: 'frontend_not_built' });
    const pathname = new URL(request.url, 'http://patchpaw.local').pathname;
    if (pathname === '/api/admin' || pathname.startsWith('/api/') || pathname === '/health' || pathname === '/github' || pathname.startsWith('/github/')) {
      return reply.code(404).send({ status: 'not_found' });
    }
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = resolve(frontendDist, relativePath);
    if (!candidate.startsWith(`${frontendDist}${sep}`)) return reply.code(400).send({ status: 'invalid_path' });
    const hasExtension = /\.[a-z0-9]+$/i.test(relativePath);
    const assetPath = existsSync(candidate) ? candidate : hasExtension ? undefined : resolve(frontendDist, 'index.html');
    if (!assetPath || !existsSync(assetPath)) return reply.code(404).send({ status: 'not_found' });
    const extension = assetPath.slice(assetPath.lastIndexOf('.')).toLowerCase();
    reply.type(frontendContentTypes[extension] ?? 'text/html; charset=utf-8');
    return reply.send(await readFile(assetPath));
  };
  // Keep API, webhook, and health routes above the SPA fallback. Unknown API paths stay JSON
  // 404s instead of being rendered as an HTML application shell.
  app.get('/', serveFrontend);
  app.get('/*', serveFrontend);
  return app;
}
