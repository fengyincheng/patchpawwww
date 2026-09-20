/**
 * Normalized inbound human reply persisted by the runner inbox.
 *
 * The transport-specific webhook parsers may add SCM provenance, but shared
 * lifecycle code only consumes this normalized shape. Keeping it here avoids
 * making approval and recovery depend on a provider client or webhook module.
 */
export interface HumanReply {
  repo: string;
  pr_number: number;
  comment_id: number;
  author: string;
  body: string;
  url: string;
  installation_id?: number;
  author_association?: string;
  source_event_id?: string;
  created_at?: string;
  platform?: 'github' | 'gitlab';
  connection_id?: string;
  project_id?: string;
  author_id?: string;
  repository_path?: string;
}
