import { spawn } from 'node:child_process';

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

function runTaskkill(pid: number) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

/** Terminate a command and its descendants using the native host mechanism. */
export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { await runTaskkill(pid); }
    catch { /* A minimal Node installation may not expose taskkill on PATH. */ }
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The process may have exited. */ }
    }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The process may have exited. */ }
    }
  }
}
