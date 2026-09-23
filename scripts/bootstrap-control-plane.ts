import { configuredRuntimeHome, loadProjectEnvIfPresent } from '../src/config/env.ts';
import { bootstrapControlPlane } from '../src/control-plane/bootstrap.ts';

loadProjectEnvIfPresent();
const explicitRepositories = process.argv.slice(2).map(fullName => ({ fullName }));
const report = await bootstrapControlPlane({ root: configuredRuntimeHome(), repositories: explicitRepositories.length ? explicitRepositories : undefined });
console.log(JSON.stringify({
  bootstrap_version: report.bootstrapVersion,
  migration_version: report.migrationVersion,
  control_plane: 'initialized',
  repositories: report.repositories.map(repository => ({ id: repository.id, full_name: repository.fullNameNormalized, revision: repository.revision })),
  public_prompts: report.publicPrompts.length,
  public_skills: report.publicSkills.length,
  provider: { id: report.provider.id, type: report.provider.type, model: report.model.modelIdentifier, credential_ref: report.provider.credentialRef },
  repository_results: report.repositoryResults.map(result => ({ repository: result.repository.fullNameNormalized, created: result.created, commands: result.commandIds.length, profile: result.profileId })),
}, null, 2));
