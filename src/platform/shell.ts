export interface HostShell {
  executable: string;
  args(command: string): string[];
}

/** Select the shell used for repository-provided validation commands. */
export function hostShell(): HostShell {
  if (process.platform === 'win32') {
    const executable = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return { executable, args: command => ['/d', '/s', '/c', command] };
  }
  return { executable: '/bin/sh', args: command => ['-lc', command] };
}
