import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { RawTraceEvent, TraceMalformedLine, TraceReadBatch } from './types.ts';

function missingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseLine(line: string, lineNumber: number, malformed: TraceMalformedLine[]) {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('trace record is not an object');
    return value as RawTraceEvent;
  } catch (error) {
    malformed.push({ line: lineNumber, message: error instanceof Error ? error.message : String(error), excerpt: line.slice(0, 400) });
    return null;
  }
}

/** Incremental JSONL reader that never treats an incomplete trailing line as malformed. */
export class TraceReader {
  private offset = 0;
  private pending = '';
  private line = 0;
  private decoder = new StringDecoder('utf8');

  constructor(readonly path: string) {}

  get currentOffset() { return this.offset; }

  async readAvailable(): Promise<TraceReadBatch> {
    let fileSize: number;
    try { fileSize = (await stat(this.path)).size; }
    catch (error) {
      if (missingFile(error)) return { records: [], malformed: [], offset: this.offset, pending: !!this.pending };
      throw error;
    }

    if (fileSize < this.offset) {
      this.offset = 0;
      this.pending = '';
      this.line = 0;
      this.decoder = new StringDecoder('utf8');
    }
    const length = fileSize - this.offset;
    if (length > 0) {
      const handle = await open(this.path, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, this.offset);
        this.offset += result.bytesRead;
        this.pending += this.decoder.write(buffer.subarray(0, result.bytesRead));
      } finally { await handle.close(); }
    }

    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    const malformed: TraceMalformedLine[] = [];
    const records = lines.flatMap(line => {
      this.line++;
      const record = parseLine(line.replace(/\r$/, ''), this.line, malformed);
      return record ? [record] : [];
    });
    return { records, malformed, offset: this.offset, pending: !!this.pending };
  }
}
