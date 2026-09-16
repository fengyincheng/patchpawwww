const SENSITIVE_KEY = /(?:authorization|api[_-]?key|access[_-]?token|private[_-]?key|webhook[_-]?secret|cookie|password|credential|(?:^|[_-])(?:token|secret)(?:$|[_-]))/i;
const TOKEN_PATTERNS = [
  /(?:ghs|ghp|github_pat)_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_-]+/g,
  /whsec_[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactText(value: string, secrets: ReadonlySet<string> = new Set()) {
  let result = value;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result;
}

export function redactValue(value: unknown, secrets: ReadonlySet<string> = new Set(), key = ''): unknown {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name,
      SENSITIVE_KEY.test(name) ? '[REDACTED]' : redactValue(child, secrets, name)]));
  }
  return value;
}

export function cleanJson(value: unknown, secrets: ReadonlySet<string> = new Set()) {
  return JSON.stringify(value, (key, child) => {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (typeof child === 'bigint') return String(child);
    if (typeof child === 'string') return redactText(child, secrets);
    return child;
  }) ?? 'null';
}
