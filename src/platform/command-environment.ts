/**
 * Environment exposed to commands executed inside a PatchPaw workspace.
 *
 * Keep this an explicit allowlist: repository commands need a usable toolchain,
 * but should not automatically receive every server credential or deployment
 * variable. Windows needs a few more operating-system variables than POSIX
 * shells do in order to resolve cmd.exe and standard temporary/user paths.
 */
export function workspaceCommandEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT']
    : ['PATH', 'HOME'];
  const selected: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (environment[name] !== undefined) selected[name] = environment[name];
  }
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY']) {
    if (environment[name] !== undefined) selected[name] = environment[name];
  }
  return selected;
}
