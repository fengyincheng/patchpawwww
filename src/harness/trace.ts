import { mkdirSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Bounded diagnostic facts for large payloads: the durable trace keeps an excerpt, the exact
// size and a fingerprint — never repeated multi-megabyte blobs. Full payloads belong to
// explicit source-of-truth artifacts (validation, closeout, review, stop-report), not trace.
export function bounded(value: unknown, cap = 4000) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return { chars: serialized.length, sha256: createHash('sha256').update(serialized).digest('hex'),
    truncated: serialized.length > cap, excerpt: serialized.slice(0, cap) };
}

export class Trace {
  readonly started = Date.now();
  executionId = 1;
  private secrets = new Set<string>();
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  secret(value: string) { if (value) this.secrets.add(value); }
  clean(value: unknown): string {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return String(v);
      if (typeof v !== 'string') return v;
      for (const secret of this.secrets) v = v.split(secret).join('[REDACTED]');
      return v.replace(/(?:ghs|ghp|github_pat)_[A-Za-z0-9_]+/g, '[REDACTED]');
    }) ?? 'null';
  }
  emit(event: string, data: object = {}) {
    appendFileSync(join(this.dir, 'trace.jsonl'), this.clean({ time: new Date().toISOString(), event, execution_id: this.executionId, ...data }) + '\n');
  }
  save(name: string, value: unknown) {
    const path = join(this.dir, name), temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, this.clean(value) + '\n');
    renameSync(temporary, path);
  }
}
