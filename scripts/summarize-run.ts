import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function summarizeRun(directory: string) {
  const dir = resolve(directory);
  const events = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const counts: Record<string, number> = {}, tools: Record<string, { calls: number; duration_ms: number; truncated: number; errors: number }> = {};
  const repeated: Record<string, number> = {};
  const reads = new Map<string, number>();
  const taskPhases = events.filter(e => e.event === 'phase');
  let requestedToolCalls = 0;
  for (const e of events.filter(e => e.event === 'model_response' && e.status === 200)) {
    try { requestedToolCalls += JSON.parse(e.raw ?? e.raw_excerpt).choices?.[0]?.message?.tool_calls?.length ?? 0; } catch {}
  }
  for (const e of events) {
    counts[e.event] = (counts[e.event] ?? 0) + 1;
    if (e.event === 'tool_end') {
      const item = tools[e.tool] ??= { calls: 0, duration_ms: 0, truncated: 0, errors: 0 };
      item.calls++; item.duration_ms += e.duration_ms ?? 0; item.truncated += Number(e.truncated); item.errors += Number(!!e.error);
    }
    if (e.event === 'tool_start' && /read|grep|search/.test(e.tool)) {
      const key = `${e.tool}:${JSON.stringify(e.args, Object.keys(e.args ?? {}).sort())}`;
      const before = reads.get(key) ?? 0; reads.set(key, before + 1);
      if (before > 0) repeated[e.tool] = (repeated[e.tool] ?? 0) + 1;
    }
  }
  return { directory: dir, counts, tools, repeated_identical_read_search_calls: repeated,
    model_requested_tool_calls: requestedToolCalls,
    phases: taskPhases.map((e, i) => ({ phase: e.phase, started_at: e.time,
      duration_ms: Date.parse(taskPhases[i + 1]?.time ?? events.at(-1).time) - Date.parse(e.time) })),
    model_response_ms: events.filter(e => e.event === 'model_response').reduce((sum, e) => sum + e.duration_ms, 0),
    max_request_chars: Math.max(0, ...events.filter(e => e.event === 'model_request').map(e =>
      typeof e.body_chars === 'number' ? e.body_chars : e.body === undefined ? 0 : JSON.stringify(e.body).length)),
    usage: events.filter(e => e.event === 'model_step').reduce((sum, e) => ({
      input_tokens: sum.input_tokens + (e.usage?.inputTokens ?? 0),
      output_tokens: sum.output_tokens + (e.usage?.outputTokens ?? 0),
      cached_input_tokens: sum.cached_input_tokens + (e.usage?.cachedInputTokens ?? 0),
    }), { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }),
  };
}

if (process.argv[1]?.endsWith('/scripts/summarize-run.ts')) {
  const dir = resolve(process.argv[2] ?? '');
  const summary = summarizeRun(dir);
  if (process.argv.includes('--save')) writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
