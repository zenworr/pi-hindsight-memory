# Security and privacy

The Pi extension and importer have full local filesystem access. Review the source before installing it globally.

## Local data

Native histories are read only. The importer writes only:

- configuration and credentials under `~/.config/pi-hindsight-memory`;
- state and dirty markers under `~/.local/state/pi-hindsight-memory`;
- temporary normalized documents under the state spool directory;
- backups under the state directory or `PI_HINDSIGHT_BACKUP_DIR`.

Directories use mode `0700`; tokens, environment files, state, and backups use mode `0600`.

## Network data

The no-LLM smoke mode sends no transcript to a language model. Local embeddings and reranking remain on the host.

When an extraction provider is enabled, redacted canonical text is sent to that provider through Hindsight. The operator must approve the provider, model, endpoint, retention policy, and cost before this step.

## Redaction limits

The redactor catches common credential formats. It cannot prove that arbitrary personal or secret data is absent. Review the dry inventory and pilot output. Do not use raw source paths or transcript text in logs.

## Hindsight operation payloads

Hindsight async operation rows can retain task payloads. The deployment sets `HINDSIGHT_API_OPERATION_RETENTION_DAYS=14` so terminal payloads are pruned. Hindsight document text remains enabled because mutable replacement, source expansion, migration, and provenance need it.

## Authentication

The API uses `ApiKeyTenantExtension` and a bearer token. PostgreSQL is on the internal container network only. The API and control plane are host-loopback-only by default. Set `HINDSIGHT_CP_ACCESS_KEY` in the private environment file if the local UI also needs a login prompt.

## Forgetting

Automatic source cleanup does not delete memory. Deletion is limited to explicit, reviewed cleanup plans that identify exact Hindsight documents.
