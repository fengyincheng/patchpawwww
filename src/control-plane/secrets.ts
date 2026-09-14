import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { patchpawPaths } from '../config/paths.ts';
import { ControlPlaneError, invalid } from './errors.ts';

const ENV_REF = /^env:[A-Z_][A-Z0-9_]*$/;
const SLOT_REF = /^slot:provider\/([a-zA-Z0-9-]+)$/;
const PROVIDER_ID = /^[a-zA-Z0-9-]+$/;

export function validateCredentialRef(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  if (!ENV_REF.test(value) && !SLOT_REF.test(value)) invalid('Credential reference must be an env reference or provider slot.', 'credential_ref');
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

  pathForRef(ref: string) {
    const match = SLOT_REF.exec(ref);
    if (!match) throw new ControlPlaneError('invalid_configuration', 'Only provider slot references have local secret paths.', 'credential_ref');
    this.assertProviderId(match[1]);
    const path = join(this.root, `${match[1]}.key`);
    if (basename(path) !== `${match[1]}.key`) throw new ControlPlaneError('invalid_configuration', 'Invalid credential slot path.', 'credential_ref');
    return path;
  }

  async writeProviderSecret(providerId: string, secret: string) {
    this.assertProviderId(providerId);
    if (typeof secret !== 'string' || secret.length === 0) invalid('Credential cannot be empty.', 'credential');
    const paths = patchpawPaths(this.runtimeHome);
    await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(paths.secrets, 0o700);
    await chmod(this.root, 0o700);
    const target = this.pathForRef(this.slotRef(providerId));
    const temporary = join(this.root, `.${providerId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, secret, { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      // Rename is atomic on one filesystem. The DB reference is committed only
      // after this point, so it can never point at a missing local slot.
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return this.slotRef(providerId);
  }

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
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new ControlPlaneError('invalid_configuration', 'Credential slot permissions are unsafe.', 'credential_ref');
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
    return stat(this.pathForRef(ref)).then(metadata => metadata.isFile() && (metadata.mode & 0o777) === 0o600, () => false);
  }

  private assertProviderId(providerId: string) {
    if (!PROVIDER_ID.test(providerId) || providerId.includes('..')) invalid('Invalid provider identifier.', 'provider_id');
  }
}

export function secretStore(runtimeHome: string) {
  return new SecretStore(runtimeHome);
}
