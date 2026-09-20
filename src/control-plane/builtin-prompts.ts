/**
 * Explicit registry of PatchPaw builtin Prompt assets.
 *
 * `operation/*.md` is seed material, not a registry: a filename alone cannot
 * tell a main execution contract from a lifecycle-only or deferred-runtime
 * Prompt. Runtime code depends on specific roles (for example the resolver
 * requires an enabled `plan-mode` binding for every `read_write_approval`
 * command), so a release that introduces a new system-known Prompt must declare
 * it here. The versioned builtin-asset migration reads this registry instead of
 * guessing identity from a directory listing.
 *
 * This is a documentation/identity contract, not a second loader: the live
 * Control Plane row remains authoritative for runtime once the asset exists.
 */
export type BuiltinPromptCategory = 'main' | 'common' | 'lifecycle' | 'deferred-runtime' | 'legacy';

export interface BuiltinPromptDefinition {
  /** Stable registry identity; also the seed key suffix (`public-prompt:<key>`). */
  key: string;
  slug: string;
  role: string;
  /** Seed source relative to the project root. */
  source: string;
  category: BuiltinPromptCategory;
  publicVisible: boolean;
  contentEditable: boolean;
  /** Runtime resolves this role, so the slug/role identity must not drift. */
  identityLocked: boolean;
  /** Whether new runs may depend on the role. Legacy-only assets are excluded. */
  newRuns: boolean;
  defaultBindingKind?: 'main' | 'common' | 'auxiliary';
  /** Runtime contracts that depend on this role being available and enabled. */
  requiredBy?: readonly string[];
}

export const BUILTIN_PROMPTS: readonly BuiltinPromptDefinition[] = [
  { key: 'review', slug: 'review', role: 'review', source: 'operation/review.md', category: 'main',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'main', requiredBy: ['execution:review'] },
  { key: 'conflict', slug: 'conflict', role: 'conflict', source: 'operation/conflict.md', category: 'main',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'main', requiredBy: ['execution:conflict'] },
  { key: 'ci-repair', slug: 'ci-repair', role: 'ci-repair', source: 'operation/ci-repair.md', category: 'main',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'main', requiredBy: ['execution:ci'] },
  { key: 'conversation', slug: 'conversation', role: 'conversation', source: 'operation/conversation.md', category: 'main',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'main', requiredBy: ['execution:conversation'] },
  { key: 'shared', slug: 'shared', role: 'shared', source: 'operation/shared.md', category: 'common',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'common' },
  { key: 'human-readable-output', slug: 'human-readable-output', role: 'human-readable-output', source: 'operation/human-readable-output.md',
    category: 'common', publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'common' },
  { key: 'plan-mode', slug: 'plan-mode', role: 'plan-mode', source: 'operation/plan-mode.md', category: 'lifecycle',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true,
    defaultBindingKind: 'auxiliary', requiredBy: ['permission:read_write_approval'] },
  { key: 'stop-closeout', slug: 'stop-closeout', role: 'stop-closeout', source: 'operation/stop-closeout.md', category: 'lifecycle',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'repair-closeout', slug: 'repair-closeout', role: 'repair-closeout', source: 'operation/repair-closeout.md', category: 'lifecycle',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'repair-completion', slug: 'repair-completion', role: 'repair-completion', source: 'operation/repair-completion.md', category: 'lifecycle',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'conversation-retry', slug: 'conversation-retry', role: 'conversation-retry', source: 'operation/conversation-retry.md', category: 'lifecycle',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'runtime-budget', slug: 'runtime-budget', role: 'runtime-budget', source: 'operation/runtime-budget.md', category: 'deferred-runtime',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'repair-feedback', slug: 'repair-feedback', role: 'repair-feedback', source: 'operation/repair-feedback.md', category: 'deferred-runtime',
    publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'repair-no-verification', slug: 'repair-no-verification', role: 'repair-no-verification', source: 'operation/repair-no-verification.md',
    category: 'deferred-runtime', publicVisible: true, contentEditable: true, identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'repair-verification-empty', slug: 'repair-verification-empty', role: 'repair-verification-empty',
    source: 'operation/repair-verification-empty.md', category: 'deferred-runtime', publicVisible: true, contentEditable: true,
    identityLocked: true, newRuns: true, defaultBindingKind: 'auxiliary' },
  { key: 'review-json-retry', slug: 'review-json-retry', role: 'review-json-retry', source: 'operation/review-json-retry.md',
    category: 'legacy', publicVisible: true, contentEditable: true, identityLocked: false, newRuns: false, defaultBindingKind: 'auxiliary' },
];

const byKey = new Map(BUILTIN_PROMPTS.map(definition => [definition.key, definition]));
const bySlug = new Map(BUILTIN_PROMPTS.map(definition => [definition.slug, definition]));
const byRole = new Map(BUILTIN_PROMPTS.map(definition => [definition.role, definition]));

export function builtinPromptByKey(key: string) {
  return byKey.get(key);
}

export function builtinPromptBySlug(slug: string) {
  return bySlug.get(slug.trim().toLowerCase());
}

export function builtinPromptByRole(role: string | null | undefined) {
  if (!role) return undefined;
  return byRole.get(role.trim().toLowerCase());
}

export function builtinPromptKeys() {
  return BUILTIN_PROMPTS.map(definition => definition.key);
}

/**
 * Builtins a fresh bootstrap installs as public assets. `publicVisible` is the
 * single gate: an unregistered `operation/*.md` file is never seeded, and a
 * registered builtin can opt out of the public inventory explicitly.
 */
export function publicBuiltinPrompts() {
  return BUILTIN_PROMPTS.filter(definition => definition.publicVisible);
}

/**
 * Builtins installed into a repository scope for new runs. Legacy-only
 * (`newRuns: false`) assets may remain publicly readable for compatibility but
 * are not copied into a fresh repository, so new runtime paths cannot depend on
 * them merely because a source file exists.
 */
export function newRunBuiltinPrompts() {
  return BUILTIN_PROMPTS.filter(definition => definition.publicVisible && definition.newRuns);
}
