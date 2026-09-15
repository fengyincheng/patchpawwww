import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { patchpawPaths } from '../config/paths.ts';
import { ControlPlaneError, invalid } from './errors.ts';

const ENV_REF = /^env:[A-Z_][A-Z0-9_]*$/;
const SLOT_REF = /^slot:provider\/([a-zA-Z0-9-]+)$/;
const SCM_SLOT_REF = /^slot:scm\/([a-zA-Z0-9_.:-]+)$/;
const SCM_WEBHOOK_SLOT_REF = /^slot:scm-webhook\/([a-zA-Z0-9_.:-]+)$/;
const PROVIDER_ID = /^[a-zA-Z0-9-]+$/;
const SCM_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const WINDOWS_SID = /\bS-\d-\d+(?:-\d+)+\b/i;
const execFileAsync = promisify(execFile);
const windowsAclScript = fileURLToPath(new URL('../../scripts/windows/protect-acl.ps1', import.meta.url));

interface WindowsAccount {
  sid: string;
}

interface WindowsAclEntry {
  sid: string;
  rights: string;
  type: string;
  inherited: boolean;
  inheritance: string;
  propagation: string;
}

interface WindowsAcl {
  entries: WindowsAclEntry[];
}

async function runWindowsCommand(command: string, args: string[]) {
  const result = await execFileAsync(command, args, { encoding: 'utf8', windowsHide: true });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function currentWindowsAccount(): Promise<WindowsAccount> {
  const userResult = await runWindowsCommand('whoami', ['/user']);
  const sid = userResult.stdout.match(WINDOWS_SID)?.[0];
  if (!sid) throw new Error('Unable to determine the current Windows account.');
  return { sid };
}

/**
 * Windows does not provide a useful POSIX mode boundary for secrets. Use the
 * native NTFS ACL APIs through the inbox PowerShell runtime instead. The
 * script replaces the DACL with one explicit rule for the current SID, so
 * verification is independent of localized account names and never trusts
 * inherited defaults.
 */
async function protectWindowsPath(path: string, directory: boolean, account: WindowsAccount) {
  await runWindowsCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsAclScript, path, account.sid, 'set', directory ? 'directory' : 'file',
  ]);
  await verifyWindowsPath(path, directory, account);
}

async function readWindowsAcl(path: string, directory: boolean): Promise<WindowsAcl> {
  const result = await runWindowsCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsAclScript, path, '', 'verify', directory ? 'directory' : 'file',
  ]);
  const parsed = JSON.parse(result.stdout) as { entries?: WindowsAclEntry | WindowsAclEntry[] };
  const rawEntries = parsed.entries;
  if (!rawEntries) throw new Error('Windows ACL query returned no DACL entries.');
  return { entries: Array.isArray(rawEntries) ? rawEntries : [rawEntries] };
}

async function verifyWindowsPath(path: string, directory: boolean, account?: WindowsAccount) {
  try {
    const current = account ?? await currentWindowsAccount();
    const acl = await readWindowsAcl(path, directory);
    if (acl.entries.length !== 1) throw new Error('The credential path has unexpected ACL entries.');
    const [entry] = acl.entries;
    if (entry.sid.toUpperCase() !== current.sid.toUpperCase() || entry.type !== 'Allow' || entry.inherited || !entry.rights.includes('FullControl') || entry.propagation !== 'None') {
      throw new Error('The current account does not have a verified restricted ACL.');
    }
    const inherited = entry.inheritance.split(/[,\s]+/).filter(Boolean);
    if (directory ? !(inherited.includes('ContainerInherit') && inherited.includes('ObjectInherit')) : inherited.length !== 1 || inherited[0] !== 'None') {
      throw new Error('The credential path has unexpected inheritance flags.');
    }
  } catch {
    throw new ControlPlaneError('invalid_configuration', 'Credential slot permissions are unsafe on this Windows host.', 'credential_ref');
  }
}

async function protectSecretPath(path: string, directory: boolean, account: WindowsAccount) {
  try {
    await protectWindowsPath(path, directory, account);
  } catch {
    throw new ControlPlaneError('invalid_configuration', 'Unable to apply safe Windows permissions to credential storage.', 'credential_ref');
  }
}

async function fileExists(path: string) {
  return stat(path).then(metadata => metadata.isFile(), () => false);
}

export function validateCredentialRef(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  if (!ENV_REF.test(value) && !SLOT_REF.test(value) && !SCM_SLOT_REF.test(value) && !SCM_WEBHOOK_SLOT_REF.test(value)) invalid('Credential reference must be an env reference or SCM/provider slot.', 'credential_ref');
  return value;
}

export class SecretStore {
  readonly root: string;

  constructor(private readonly runtimeHome: string) {
    this.root = patchpawPaths(runtimeHome).providerSecrets;
  }

  slotRef(providerId: string) {
    this.assertProviderId(providerId);
    return `slot:provider/${providerId}`;
  }

  scmSlotRef(connectionId: string) {
    this.assertScmId(connectionId);
    return `slot:scm/${connectionId}`;
  }

  scmWebhookSlotRef(connectionId: string) {
    this.assertScmId(connectionId);
    return `slot:scm-webhook/${connectionId}`;
  }

  pathForRef(ref: string) {
    const providerMatch = SLOT_REF.exec(ref);
    const match = providerMatch ?? SCM_SLOT_REF.exec(ref) ?? SCM_WEBHOOK_SLOT_REF.exec(ref);
    if (!match) throw new ControlPlaneError('invalid_configuration', 'Only local slot references have local secret paths.', 'credential_ref');
    if (providerMatch) this.assertProviderId(match[1]);
    else this.assertScmId(match[1]);
    const directory = SLOT_REF.test(ref) ? this.root : join(patchpawPaths(this.runtimeHome).secrets, SCM_WEBHOOK_SLOT_REF.test(ref) ? 'scm-webhook' : 'scm');
    const path = join(directory, `${match[1]}.key`);
    if (basename(path) !== `${match[1]}.key`) throw new ControlPlaneError('invalid_configuration', 'Invalid credential slot path.', 'credential_ref');
    return path;
  }

  async writeProviderSecret(providerId: string, secret: string) {
    this.assertProviderId(providerId);
    if (typeof secret !== 'string' || secret.length === 0) invalid('Credential cannot be empty.', 'credential');
    const paths = patchpawPaths(this.runtimeHome);
    await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let windowsAccount: WindowsAccount | undefined;
    if (process.platform !== 'win32') {
      await chmod(paths.secrets, 0o700);
      await chmod(this.root, 0o700);
    } else {
      try {
        windowsAccount = await currentWindowsAccount();
        await protectWindowsPath(paths.secrets, true, windowsAccount);
        await protectWindowsPath(this.root, true, windowsAccount);
      } catch {
        throw new ControlPlaneError('invalid_configuration', 'Unable to apply safe Windows permissions to credential storage.', 'credential_ref');
      }
    }
    const target = this.pathForRef(this.slotRef(providerId));
    const temporary = join(this.root, `.${providerId}.${randomUUID()}.tmp`);
    let backup: string | undefined;
    let targetPublished = false;
    try {
      await writeFile(temporary, secret, { encoding: 'utf8', mode: 0o600 });
      if (windowsAccount) await protectSecretPath(temporary, false, windowsAccount);
      else await chmod(temporary, 0o600);

      if (windowsAccount) {
        // Windows rename does not replace an existing file. Keep the old slot
        // recoverable until the new file has been protected and verified.
        if (await fileExists(target)) {
          // Repair the old slot's DACL before moving it out of the way. This
          // also lets an operator rotate a slot after an ACL was accidentally
          // broadened, while refusing the operation if the current account can
          // no longer safely control the existing file.
          await protectSecretPath(target, false, windowsAccount);
          backup = join(this.root, `.${providerId}.${randomUUID()}.previous`);
          await rename(target, backup);
        }
        await rename(temporary, target);
        targetPublished = true;
        await protectSecretPath(target, false, windowsAccount);
        if (backup) {
          await rm(backup, { force: true });
          backup = undefined;
        }
      } else {
        // Rename is atomic on one filesystem. The DB reference is committed
        // only after this point, so it can never point at a missing local slot.
        await rename(temporary, target);
        targetPublished = true;
        await chmod(target, 0o600);
      }
    } catch (error) {
      if (windowsAccount) {
        if (targetPublished) await rm(target, { force: true }).catch(() => undefined);
        if (backup) await rename(backup, target).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (backup) await rm(backup, { force: true }).catch(() => undefined);
    }
    return this.slotRef(providerId);
  }

  private async writeScmSlot(connectionId: string, secret: string, webhook: boolean) {
    const paths = patchpawPaths(this.runtimeHome);
    const root = join(paths.secrets, webhook ? 'scm-webhook' : 'scm');
    await mkdir(root, { recursive: true, mode: 0o700 });
    let windowsAccount: WindowsAccount | undefined;
    if (process.platform !== 'win32') { await chmod(paths.secrets, 0o700); await chmod(root, 0o700); }
    else {
      try {
        windowsAccount = await currentWindowsAccount();
        await protectWindowsPath(paths.secrets, true, windowsAccount);
        await protectWindowsPath(root, true, windowsAccount);
      } catch { throw new ControlPlaneError('invalid_configuration', 'Unable to apply safe Windows permissions to SCM credential storage.', 'credential_ref'); }
    }
    const ref = webhook ? this.scmWebhookSlotRef(connectionId) : this.scmSlotRef(connectionId);
    const target = this.pathForRef(ref);
    const temporary = join(root, `.${connectionId}.${randomUUID()}.tmp`);
    let backup: string | undefined;
    let targetPublished = false;
    try {
      await writeFile(temporary, secret, { encoding: 'utf8', mode: 0o600 });
      if (windowsAccount) await protectSecretPath(temporary, false, windowsAccount);
      else await chmod(temporary, 0o600);
      if (windowsAccount && await fileExists(target)) {
        await protectSecretPath(target, false, windowsAccount);
        backup = join(root, `.${connectionId}.${randomUUID()}.previous`);
        await rename(target, backup);
      }
      await rename(temporary, target);
      targetPublished = true;
      if (windowsAccount) await protectSecretPath(target, false, windowsAccount);
      else await chmod(target, 0o600);
      if (backup) { await rm(backup, { force: true }); backup = undefined; }
    } catch (error) {
      if (windowsAccount) {
        if (targetPublished) await rm(target, { force: true }).catch(() => undefined);
        if (backup) await rename(backup, target).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (backup) await rm(backup, { force: true }).catch(() => undefined);
    }
    return ref;
  }

  async writeScmSecret(connectionId: string, secret: string) {
    this.assertScmId(connectionId);
    if (typeof secret !== 'string' || secret.length === 0) invalid('Credential cannot be empty.', 'credential');
    return this.writeScmSlot(connectionId, secret, false);
  }

  async writeScmWebhookSecret(connectionId: string, secret: string) {
    this.assertScmId(connectionId);
    if (typeof secret !== 'string' || secret.length === 0) invalid('Credential cannot be empty.', 'secret');
    return this.writeScmSlot(connectionId, secret, true);
  }

  async deleteScmSecret(connectionId: string) { const ref = this.scmSlotRef(connectionId); await rm(this.pathForRef(ref), { force: true }); return ref; }

  async deleteScmWebhookSecret(connectionId: string) { const ref = this.scmWebhookSlotRef(connectionId); await rm(this.pathForRef(ref), { force: true }); return ref; }

  async deleteProviderSecret(providerId: string) {
    const ref = this.slotRef(providerId);
    const path = this.pathForRef(ref);
    await rm(path, { force: true });
    return ref;
  }

  /** Read only at provider-call time; callers must not serialize the return value. */
  async read(ref: string, env: NodeJS.ProcessEnv = process.env) {
    validateCredentialRef(ref);
    if (ENV_REF.test(ref)) {
      const key = ref.slice(4);
      const value = env[key];
      if (!value) throw new ControlPlaneError('invalid_configuration', `Credential environment reference is unavailable: ${key}`, 'credential_ref');
      return value;
    }
    const path = this.pathForRef(ref);
    const metadata = await stat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ControlPlaneError('invalid_configuration', 'Credential slot is unavailable.', 'credential_ref');
      }
      throw error;
    });
    if (!metadata.isFile()) throw new ControlPlaneError('invalid_configuration', 'Credential slot permissions are unsafe.', 'credential_ref');
    if (process.platform === 'win32') await verifyWindowsPath(path, false);
    else if ((metadata.mode & 0o777) !== 0o600) throw new ControlPlaneError('invalid_configuration', 'Credential slot permissions are unsafe.', 'credential_ref');
    const value = await readFile(path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ControlPlaneError('invalid_configuration', 'Credential slot is unavailable.', 'credential_ref');
      }
      throw error;
    });
    return value;
  }

  async isConfigured(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
    if (!ref) return false;
    validateCredentialRef(ref);
    if (ENV_REF.test(ref)) return !!env[ref.slice(4)];
    return stat(this.pathForRef(ref)).then(async metadata => {
      if (!metadata.isFile()) return false;
      if (process.platform === 'win32') {
        try {
          await verifyWindowsPath(this.pathForRef(ref), false);
          return true;
        } catch {
          return false;
        }
      }
      return (metadata.mode & 0o777) === 0o600;
    }, () => false);
  }

  private assertProviderId(providerId: string) {
    if (!PROVIDER_ID.test(providerId) || providerId.includes('..')) invalid('Invalid provider identifier.', 'provider_id');
  }

  private assertScmId(connectionId: string) {
    if (!SCM_ID.test(connectionId) || connectionId.includes('..')) invalid('Invalid SCM connection identifier.', 'connection_id');
  }
}

export function secretStore(runtimeHome: string) {
  return new SecretStore(runtimeHome);
}
