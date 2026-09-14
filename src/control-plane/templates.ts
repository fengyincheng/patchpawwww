import { ControlPlaneError } from './errors.ts';

export type TemplateType = 'conversation' | 'custom' | 'review' | 'repair' | 'ci' | 'conflict';
export type TemplateValue = string | number | boolean | null | undefined;

export interface TemplatePlaceholder {
  name: string;
  optional: boolean;
  index: number;
}

export interface TemplateValidation {
  templateType: TemplateType;
  role: string | null;
  placeholders: TemplatePlaceholder[];
  usedVariables: string[];
}

export interface RenderedTemplate {
  text: string;
  usedVariables: string[];
  ignoredVariables: string[];
}

const PLACEHOLDER = /\{\{([a-z][a-zA-Z0-9_]*)(\?)?\}\}/g;
const MALFORMED_PLACEHOLDER = /\{\{[^}]*\}\}/g;

// The allow-list is deliberately code-owned. User-editable assets can choose
// which facts they use, but cannot turn a secret or arbitrary process value
// into a prompt variable.
const COMMON_VARIABLES = new Set([
  'repository', 'repositoryFullName', 'prNumber', 'prTitle', 'prBody',
  'prHeadSha', 'baseRef', 'baseSha', 'currentBaseTipSha', 'comment', 'comments',
  'task', 'command', 'executionId', 'workspace', 'proposal', 'approval',
]);

const TEMPLATE_VARIABLES: Record<TemplateType, Set<string>> = {
  conversation: new Set([...COMMON_VARIABLES]),
  custom: new Set([...COMMON_VARIABLES, 'ciEvidence', 'evidence', 'remaining', 'guidance', 'closeoutSteps', 'lastIssue', 'humanMessage']),
  review: new Set([...COMMON_VARIABLES, 'ciEvidence']),
  repair: new Set([...COMMON_VARIABLES, 'ciEvidence', 'evidence', 'remaining', 'guidance', 'closeoutSteps', 'lastIssue', 'humanMessage']),
  ci: new Set([...COMMON_VARIABLES, 'ciEvidence', 'evidence', 'remaining', 'guidance', 'closeoutSteps', 'lastIssue', 'humanMessage']),
  conflict: new Set([...COMMON_VARIABLES, 'ciEvidence', 'evidence', 'remaining', 'guidance', 'closeoutSteps', 'lastIssue', 'humanMessage']),
};

const ROLE_VARIABLES: Record<string, Set<string>> = {
  'repair-feedback': new Set(['evidence']),
  'repair-closeout': new Set(['closeoutSteps', 'lastIssue']),
  'runtime-budget': new Set(['remaining', 'guidance']),
  'stop-closeout': new Set(['humanMessage']),
};

function normalizeTemplateContent(content: string) {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function allowedVariables(templateType: TemplateType, role: string | null | undefined) {
  const result = new Set(TEMPLATE_VARIABLES[templateType]);
  const roleVariables = role ? ROLE_VARIABLES[role] : undefined;
  if (roleVariables) for (const variable of roleVariables) result.add(variable);
  return result;
}

function parsePlaceholders(content: string) {
  const normalized = normalizeTemplateContent(content);
  const placeholders: TemplatePlaceholder[] = [];
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(normalized))) {
    placeholders.push({ name: match[1], optional: Boolean(match[2]), index: match.index });
  }
  PLACEHOLDER.lastIndex = 0;
  const recognized = new Set(placeholders.map(value => value.index));
  for (const malformed of normalized.matchAll(MALFORMED_PLACEHOLDER)) {
    if (!recognized.has(malformed.index ?? -1)) {
      throw new ControlPlaneError('invalid_configuration', 'Prompt contains a malformed template placeholder.', 'content');
    }
  }
  return placeholders;
}

export function validateTemplate(content: string, options: { templateType: TemplateType; role?: string | null }): TemplateValidation {
  if (typeof content !== 'string') throw new ControlPlaneError('invalid_configuration', 'Template content must be text.', 'content');
  const placeholders = parsePlaceholders(content);
  const allowed = allowedVariables(options.templateType, options.role);
  const unknown = [...new Set(placeholders.map(value => value.name).filter(value => !allowed.has(value)))];
  if (unknown.length) {
    throw new ControlPlaneError('unknown_template_variable', `Unknown template variable in ${options.role ?? options.templateType}: ${unknown.join(', ')}`, 'content');
  }
  return { templateType: options.templateType, role: options.role ?? null, placeholders,
    usedVariables: [...new Set(placeholders.map(value => value.name))] };
}

export function renderTemplate(content: string, values: Record<string, TemplateValue>, options: { templateType: TemplateType; role?: string | null }): string {
  return renderTemplateWithDiagnostics(content, values, options).text;
}

export function renderTemplateWithDiagnostics(content: string, values: Record<string, TemplateValue>, options: { templateType: TemplateType; role?: string | null }): RenderedTemplate {
  const validation = validateTemplate(content, options);
  const used = new Set(validation.placeholders.map(value => value.name));
  const rendered = normalizeTemplateContent(content).replace(PLACEHOLDER, (_whole, name: string, optional: string | undefined) => {
    const value = values[name];
    if (value === undefined || value === null) {
      if (optional) return '';
      throw new ControlPlaneError('missing_required_template_variable', `Missing required template variable: ${options.role ?? options.templateType}.${name}`, 'content');
    }
    return String(value);
  });
  PLACEHOLDER.lastIndex = 0;
  return { text: rendered, usedVariables: [...used], ignoredVariables: Object.keys(values).filter(key => !used.has(key)).sort() };
}

export const validatePromptTemplate = validateTemplate;
export const renderPromptTemplate = renderTemplate;

export function outputContractForTemplate(templateType: TemplateType) {
  switch (templateType) {
    case 'review': return { kind: 'strict_json' as const, schemaId: 'review-result-v1' };
    case 'conflict': return { kind: 'strict_json' as const, schemaId: 'conflict-proposal-v1' };
    case 'conversation': return { kind: 'human_markdown' as const };
    // Custom commands deliberately have no built-in output schema. Their selected
    // Prompt defines the task, and the resulting natural-language answer is published
    // as-is by the runner.
    case 'custom': return { kind: 'none' as const };
    default: return { kind: 'none' as const };
  }
}
