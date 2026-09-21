import { resolveRun } from '../src/observability/run-resolver.ts';
import { parseTargetCommandArgs, targetCommandHelp } from '../src/observability/cli-options.ts';
import { readNormalizedTrace, readRunResult, readCommandFacts } from '../src/observability/run-reader.ts';
import { readPublicationView } from '../src/observability/publication.ts';
import { renderMalformed, renderSummary } from '../src/observability/renderer.ts';
import { summarizeRun } from '../src/observability/run-summary.ts';

async function main() {
  const options = parseTargetCommandArgs(process.argv.slice(2), 'agent:status');
  if (options.help) { console.log(targetCommandHelp('agent:status')); return; }
  const run = await resolveRun(options.target);
  const trace = await readNormalizedTrace(run);
  for (const malformed of trace.malformed) console.error(renderMalformed(malformed.line, malformed.message, malformed.excerpt, options.mode));
  const result = await readRunResult(run);
  const publication = await readPublicationView({ dir: run.dir, events: trace.events, terminal: !!result });
  const command = await readCommandFacts(run.dir);
  console.log(renderSummary(summarizeRun({ runId: run.runId, manifest: run.manifest, result, state: run.state, events: trace.events, publication, command }), options.mode));
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
