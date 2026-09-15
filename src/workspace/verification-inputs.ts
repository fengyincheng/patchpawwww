import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.ts';
import type { Trace } from '../harness/trace.ts';

type SavedFile = { content: Buffer; mode: number };
export type VerificationInputs = Map<string, SavedFile>;
const isVerificationInput = (path: string) => /(^|\/)(tests?|__tests__|specs?|test-support)\/|[._-](test|spec)[._-]|^\.github\/workflows\/|^\.gitlab-ci\.yml$|(^|\/)package\.json$/.test(path);

async function readOptional(path: string): Promise<SavedFile | null> {
  try { return { content: await readFile(path), mode: (await stat(path)).mode }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
// Preserve inputs as evidence only. A conflicted input is not an executable test baseline.
export async function captureVerificationInputs(path: string, trace: Trace): Promise<VerificationInputs> {
  const paths = new Set((await git(path, ['ls-files', '-z'], trace)).stdout.split('\0').filter(p => p && isVerificationInput(p)));
  const saved: VerificationInputs = new Map();
  for (const name of paths) {
    const file = await readOptional(join(path, name));
    if (file) saved.set(name, file);
  }
  trace.save('verification-inputs.json', [...saved].map(([path, file]) => ({ path,
    sha256: createHash('sha256').update(file.content).digest('hex') })));
  trace.save('verification-inputs-content.json', [...saved].map(([path, file]) => ({ path, content: file.content.toString('utf8') })));
  return saved;
}

export async function changedVerificationInputs(path: string, original: VerificationInputs) {
  const changed: string[] = [];
  for (const [name, frozen] of original) {
    const current = await readOptional(join(path, name));
    if (!current || !current.content.equals(frozen.content) || current.mode !== frozen.mode) changed.push(name);
  }
  return changed;
}
