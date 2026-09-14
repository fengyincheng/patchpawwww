import { loadConfig, projectRoot } from './config/env.ts';
import { dispatchHumanReply } from './runner/dispatch.ts';
import { createGitHub } from './github/client.ts';
import { buildServer } from './server/app.ts';
import { startCommunicationScheduler } from './runner/communication-scheduler.ts';

let communication: ReturnType<typeof startCommunicationScheduler> | undefined;
try {
  const config = loadConfig();
  const runtimeHome = config.runtimeHome;
  const github = createGitHub(config);
  communication = startCommunicationScheduler({ ...config, root: runtimeHome }, github,
    comment => dispatchHumanReply(runtimeHome, comment, projectRoot));
  await communication.ready;
  const app = buildServer({ ...config, root: runtimeHome, botLogin: config.botLogin }, github, true,
    comment => dispatchHumanReply(runtimeHome, comment, projectRoot));
  await app.listen({ host: '127.0.0.1', port: config.port });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { communication?.stop(); void app.close(); });
  }
} catch (error) {
  communication?.stop();
  // Avoid dumping SDK/config objects containing credentials.
  console.error(JSON.stringify({ status: 'startup_failed', code: (error as NodeJS.ErrnoException).code ?? 'CONFIG_OR_STARTUP' }));
  process.exitCode = 1;
}
