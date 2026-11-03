import type { ChangeRequestSnapshot } from './types.ts';

const storageKeyPattern = /^(?:gitlab|github):[^:]+:project:.+$/i;

export function recipientLogins(values: Array<string | null | undefined>) {
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const login = candidate?.trim();
    if (!login || storageKeyPattern.test(login)) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(login);
  }
  return recipients;
}

export function changeRequestRecipients(
  changeRequest: ChangeRequestSnapshot | undefined,
  operatorLogin?: string,
  triggeringAuthors: Array<string | null | undefined> = [],
) {
  const githubOwner = changeRequest?.kind === 'github'
    ? changeRequest.repository.pathWithNamespace.split('/')[0]
    : undefined;
  return recipientLogins([
    changeRequest?.author.login,
    operatorLogin ?? githubOwner,
    ...triggeringAuthors,
  ]);
}
