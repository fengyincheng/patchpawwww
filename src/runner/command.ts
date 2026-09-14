import type { ControlPlaneDb } from '../control-plane/db.ts';
import { getCommandByName } from '../control-plane/commands.ts';
import type { ExecutionType } from '../control-plane/types.ts';

export type PRTask = 'conversation' | ExecutionType | 'stop' | 'close';
export type ReservedControl = 'stop' | 'close' | 'approval';

export type ParsedIntent =
  | { kind: 'conversation'; repositoryId: string; reason?: 'plain_mention' | 'unknown_command' | 'disabled_command' | 'ambiguous_command' }
  | { kind: 'control'; control: ReservedControl }
  | { kind: 'command'; commandId: string; slashName: string; executionType: ExecutionType; permission: 'read_only' | 'read_write' };

const STATIC_COMMANDS = new Set(['conflict', 'confict', 'review', 'ci', 'stop', 'close']);
const RESERVED_CONTROLS = new Set<ReservedControl>(['stop', 'close', 'approval']);

interface MentionCommand {
  name: string;
  line: string;
}

function removeNonExecutableText(body: string) {
  const withoutFences = body.replace(/```[\s\S]*?```/g, '');
  return withoutFences.split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
}

function mentionCommands(body: string, botLogin: string): MentionCommand[] {
  const escaped = botLogin.replace(/\[bot\]$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = removeNonExecutableText(body);
  const mention = new RegExp(`^[ \\t]*@${escaped}(?:\\[bot\\])?\\s+/(?:([a-z][a-z0-9-]{0,31}))(?=$|\\s)`, 'gim');
  return [...text.matchAll(mention)].map(match => {
    const start = (match.index ?? 0) + match[0].length;
    return { name: match[1].toLowerCase(), line: text.slice(start).split('\n')[0] };
  });
}

function hasAnotherCommand(line: string) {
  return /(?:^|\s)\/[a-z][a-z0-9-]{0,31}(?=$|\s)/i.test(line);
}

function lexicalCommand(body: string, botLogin: string) {
  const matches = mentionCommands(body, botLogin);
  const ambiguous = matches.length > 1 || (matches.length === 1 && hasAnotherCommand(matches[0].line));
  return { command: matches.length === 1 && !ambiguous ? matches[0] : undefined, ambiguous };
}

/**
 * Resolve one @ mention against the repository's control-plane command registry.
 * Unknown and disabled commands deliberately remain conversation so a comment can
 * never authorize a task merely because it resembles a slash command.
 */
export async function parsePRIntent(db: ControlPlaneDb, repositoryId: string, body: string, botLogin: string): Promise<ParsedIntent> {
  const lexical = lexicalCommand(body, botLogin);
  if (lexical.ambiguous) return { kind: 'conversation', repositoryId, reason: 'ambiguous_command' };
  if (!lexical.command) return { kind: 'conversation', repositoryId, reason: 'plain_mention' };
  const candidate = lexical.command!;
  const name = candidate.name === 'confict' ? 'conflict' : candidate.name === 'approve' ? 'approval' : candidate.name;
  if (RESERVED_CONTROLS.has(name as ReservedControl)) return { kind: 'control', control: name as ReservedControl };
  const command = await getCommandByName(db, repositoryId, name);
  if (!command) return { kind: 'conversation', repositoryId, reason: 'unknown_command' };
  if (!command.enabled) return { kind: 'conversation', repositoryId, reason: 'disabled_command' };
  return { kind: 'command', commandId: command.id, slashName: command.slashName,
    executionType: command.executionType, permission: command.permission };
}

// Only a command immediately following the bot mention is executable. Code blocks,
// quotations and ordinary discussion of a command are not task requests.
export function parsePRTask(body: string, botLogin: string): PRTask {
  const candidate = lexicalCommand(body, botLogin).command;
  if (!candidate || !STATIC_COMMANDS.has(candidate.name)) return 'conversation';
  if (candidate.name === 'confict') return 'conflict';
  return candidate.name as PRTask;
}
