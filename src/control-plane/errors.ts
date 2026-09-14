export type ControlPlaneErrorCode =
  | 'invalid_configuration'
  | 'not_found'
  | 'revision_conflict'
  | 'referenced_resource'
  | 'required_binding'
  | 'slug_conflict'
  | 'binding_conflict'
  | 'unsupported_migration'
  | 'provider_unavailable'
  | 'unknown_template_variable'
  | 'missing_required_template_variable'
  | 'incompatible_output_contract'
  | 'snapshot_missing'
  | 'snapshot_corrupt'
  | 'snapshot_integrity_mismatch'
  | 'snapshot_schema_unsupported'
  | 'snapshot_immutable_conflict';

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    message: string,
    readonly field?: string,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export function notFound(resource: string, id: string): never {
  throw new ControlPlaneError('not_found', `${resource} was not found: ${id}`);
}

export function assertExpectedRevision(actual: number, expected: number | undefined, resource: string) {
  if (expected !== undefined && expected !== actual) {
    throw new ControlPlaneError('revision_conflict', `${resource} changed; reload before saving.`, 'expected_revision', {
      current_revision: actual,
    });
  }
}

export function invalid(message: string, field?: string): never {
  throw new ControlPlaneError('invalid_configuration', message, field);
}

export function isSqliteConstraint(error: unknown) {
  return error instanceof Error && /constraint|unique|foreign key/i.test(error.message);
}

export function rethrowConstraint(error: unknown, fallback: string): never {
  if (error instanceof ControlPlaneError) throw error;
  throw new ControlPlaneError('binding_conflict', fallback);
}
