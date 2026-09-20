import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const operationRoot = fileURLToPath(new URL('../../operation/', import.meta.url));
const operationName = /^[a-z][a-z0-9-]*$/;
const operationSourcePath = /^operation\/([a-z][a-z0-9-]*)\.md$/;
const placeholder = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;

export const OPERATION_PROMPT_VERSION = 'operation-v1';

function readOperationFile(path: string, label: string) {
  try {
    return readFileSync(path, 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Required operation asset is missing: ${label}`);
    }
    throw error;
  }
}

export function loadOperation(name: string) {
  if (!operationName.test(name)) throw new Error(`Invalid operation asset name: ${name}`);
  try {
    return readFileSync(join(operationRoot, `${name}.md`), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Required operation asset is missing: operation/${name}.md`);
    }
    throw error;
  }
}

/**
 * Resolve the seed file name declared by a builtin registry `source`
 * (`operation/<file>.md`). The registry decides identity; the source path
 * decides which seed file is read, so the two can differ.
 */
export function operationSourceName(source: string) {
  const match = operationSourcePath.exec(source);
  if (!match) throw new Error(`Invalid operation source path: ${source}`);
  return match[1];
}

/**
 * Load builtin seed content from an explicit registry `source` path. Callers
 * must pass `definition.source`; never rebuild the filename from a slug.
 * `root` defaults to the repository operation directory and may be overridden
 * by tooling/tests with a flat directory of seed files.
 */
export function loadOperationSource(source: string, root: string = operationRoot) {
  const name = operationSourceName(source);
  return readOperationFile(join(root, `${name}.md`), source);
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
