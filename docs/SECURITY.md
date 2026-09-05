# Security and privacy

The Pi extension and importer have full local filesystem access. Review the source before installing it globally.

## Local data

Native histories are read only. The importer writes only:

- configuration and credentials under `~/.config/pi-hindsight-memory`;
- importer state under `~/.local/state/pi-hindsight-memory`;
- normalized documents and recoverable pending-operation payloads under the state spool directory;
- a private local transcript index and optional reviewed-fact file;
- backups under the state directory or `PI_HINDSIGHT_BACKUP_DIR`.

Directories use mode `0700`; tokens, environment files, state, and backups use mode `0600`.

## Network data

The no-LLM smoke mode sends no transcript to a language model. Local embeddings and reranking run on the Hindsight service host.

When an extraction provider is enabled, redacted canonical text is sent to that provider through Hindsight. Outbound metadata is also redacted. Source paths, working directories, titles, project IDs, and native session identifiers are not anonymized by default and can remain in metadata and search results. The operator must approve the provider, model, endpoint, retention policy, and cost before this step.

## Redaction limits

The redactor catches common credential formats. It cannot prove that arbitrary personal or secret data is absent. Review the dry inventory and pilot output. Do not put transcript text or original credential values in logs. Redacted source paths can appear in diagnostic errors.

Pending payloads also contain local source locators and classification metadata needed for safe recovery. Treat the state directory as sensitive. A local search index is not encrypted merely because it has mode `0600`.

## Hindsight operation payloads

Hindsight async operation rows can retain task payloads. The deployment sets `HINDSIGHT_API_OPERATION_RETENTION_DAYS=14` so terminal payloads are pruned. Hindsight document text remains enabled because mutable replacement, source expansion, migration, and provenance need it.

## Authentication

The API uses `ApiKeyTenantExtension` and a bearer token. PostgreSQL is on the internal container network only and receives a separate minimal environment file without Hindsight API or provider credentials. The API and control plane are host-loopback-only by default. Set `HINDSIGHT_CP_ACCESS_KEY` in the private environment file if the UI also needs a login prompt. An anonymous control plane can expose document text and forward privileged API operations; API bearer authentication alone does not protect that UI. Protect both its proxy route and direct port, or explicitly accept access by every reachable client.

## Forgetting

Automatic source cleanup does not delete memory. Deletion is limited to explicit, reviewed cleanup plans that identify exact Hindsight documents.
