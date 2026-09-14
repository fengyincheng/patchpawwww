import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const operationRoot = fileURLToPath(new URL('../../operation/', import.meta.url));
const operationName = /^[a-z][a-z0-9-]*$/;
const placeholder = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;

export const OPERATION_PROMPT_VERSION = 'operation-v1';

export function loadOperation(name: string) {
  if (!operationName.test(name)) throw new Error(`Invalid operation asset name: ${name}`);
  try {
    return readFileSync(`${operationRoot}${name}.md`, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Required operation asset is missing: operation/${name}.md`);
    }
    throw error;
  }
}

export function renderOperation(name: string, values: Record<string, string | number>) {
  const source = loadOperation(name);
  const used = new Set<string>();
  const rendered = source.replace(placeholder, (_, key: string) => {
    used.add(key);
    if (!(key in values)) throw new Error(`Missing value for operation placeholder: ${name}.${key}`);
    return String(values[key]);
  });
  const unknown = Object.keys(values).filter(key => !used.has(key));
  if (unknown.length) throw new Error(`Unused operation values for ${name}: ${unknown.join(', ')}`);
  return rendered;
}

export function composeOperations(...names: string[]) {
  return names.map(loadOperation).join('\n\n');
}
