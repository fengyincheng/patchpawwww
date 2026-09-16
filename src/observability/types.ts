export type RawTraceEvent = Record<string, unknown>;

export interface TraceMalformedLine {
  line: number;
  message: string;
  excerpt: string;
}

export interface TraceReadBatch {
  records: RawTraceEvent[];
  malformed: TraceMalformedLine[];
  offset: number;
  pending: boolean;
}

export const OBSERVABLE_KINDS = [
  'run', 'phase', 'model', 'thinking', 'tool', 'git', 'validation',
  'workspace', 'warning', 'error', 'result',
] as const;

export type ObservableKind = typeof OBSERVABLE_KINDS[number];

export interface ObservableEvent {
  time: string;
  runId: string;
  executionId?: number;
  sourceEvent?: string;
  kind: ObservableKind;
  title: string;
  status?: string;
  detail?: Record<string, unknown>;
}
