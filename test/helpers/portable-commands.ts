/** Commands used by tests that must run under both POSIX shells and cmd.exe. */
export function nodeExit(code: number) {
  return `node -e "process.exit(${code})"`;
}

export function nodeFileExists(path: string) {
  return `node -e "require('node:fs').accessSync('${path}')"`;
}

export function nodeFileEquals(path: string, content: string) {
  const expected = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "if (require('node:fs').readFileSync('${path}').toString('base64') !== '${expected}') process.exit(1)"`;
}

export function nodeWriteFile(path: string, content: string) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('node:fs').writeFileSync('${path}', Buffer.from('${encoded}', 'base64'))"`;
}
