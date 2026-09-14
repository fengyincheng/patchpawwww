import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer, type Server } from 'node:net';
import { patchpawPaths } from '../config/paths.ts';

export type CommunicationWakeTransport = 'unix' | 'pipe' | 'memory';

function nativeTransport(requested?: CommunicationWakeTransport): CommunicationWakeTransport {
  if (requested === 'memory') return 'memory';
  if (process.platform === 'win32') return 'pipe';
  return requested === 'pipe' ? 'unix' : 'unix';
}

function windowsPipePath(runtimeHome: string) {
  const identity = createHash('sha256').update(resolve(runtimeHome)).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\patchpaw-communication-${identity}`;
}

export function communicationWakeTransport(requested?: CommunicationWakeTransport) {
  return nativeTransport(requested);
}

export const communicationWakePath = (runtimeHome: string, requested?: CommunicationWakeTransport, configuredPath?: string) => {
  const transport = nativeTransport(requested);
  if (transport === 'memory') return undefined;
  if (transport === 'pipe') {
    // Windows named pipes are not filesystem entries. A configured pipe is
    // accepted only when it already uses the native namespace; otherwise the
    // runtime-home identity prevents collisions between service instances.
    return process.platform === 'win32' && configuredPath?.startsWith('\\\\.\\pipe\\')
      ? configuredPath
      : windowsPipePath(runtimeHome);
  }
  return configuredPath ?? join(patchpawPaths(runtimeHome).locks, 'communication-wakeup.sock');
};

const listeners = new Map<string, () => void>();
const reportedFailures = new Set<string>();

export function registerCommunicationWake(runtimeHome: string, listener: () => void) {
  listeners.set(runtimeHome, listener);
  return () => { if (listeners.get(runtimeHome) === listener) listeners.delete(runtimeHome); };
}

export interface CommunicationWakeServer {
  server: Server;
  endpoint: string;
  transport: Exclude<CommunicationWakeTransport, 'memory'>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createCommunicationWakeServer(
  runtimeHome: string,
  listener: () => void,
  requested?: CommunicationWakeTransport,
  configuredPath?: string,
): CommunicationWakeServer {
  const transport = nativeTransport(requested);
  if (transport === 'memory') throw new Error('Memory wake transport does not create a server');
  const endpoint = communicationWakePath(runtimeHome, transport, configuredPath)!;
  const server = createServer(socket => {
    socket.resume();
    socket.on('data', () => {});
    socket.on('end', listener);
    socket.on('error', () => {});
  });
  return {
    server,
    endpoint,
    transport,
    async listen() {
      // Unix domain sockets leave a filesystem node behind after an unclean
      // shutdown. Named pipes are owned by the server and must not be rm'd.
      if (transport === 'unix') {
        await rm(endpoint, { force: true });
        await mkdir(dirname(endpoint), { recursive: true });
      }
      await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolveListen(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(endpoint);
      });
    },
    async close() {
      if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      if (transport === 'unix') await rm(endpoint, { force: true });
    },
  };
}

/** The socket is a nudge only. SQLite remains the source of truth. */
export function wakeCommunicationScheduler(runtimeHome: string): Promise<boolean> {
  const listener = listeners.get(runtimeHome);
  if (listener) { listener(); return Promise.resolve(true); }
  return new Promise(resolve => {
    let settled = false;
    const endpoint = communicationWakePath(runtimeHome);
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      resolve(delivered);
    };
    if (!endpoint) { finish(false); return; }
    const socket = createConnection(endpoint);
    socket.once('error', error => {
      // A detached worker can legitimately finish while the main process is
      // down. The row is already durable; false tells the caller that the
      // nudge did not arrive so the failure is observable instead of being
      // swallowed by a destroy-only error handler.
      if (!reportedFailures.has(runtimeHome)) {
        reportedFailures.add(runtimeHome);
        console.error(JSON.stringify({ status: 'communication_wake_send_failed',
          error_name: error.name, error_code: (error as NodeJS.ErrnoException).code ?? null }));
      }
      socket.destroy();
      finish(false);
    });
    socket.once('connect', () => {
      reportedFailures.delete(runtimeHome);
      socket.end('wake\n');
      finish(true);
    });
  });
}
