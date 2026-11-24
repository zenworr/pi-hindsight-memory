# Provider gate

Hindsight can store chunks without an LLM, but durable fact extraction and observation consolidation require an approved provider.

## OpenAI API key

Use the secure helper and select an available model explicitly:

```bash
scripts/configure-provider.sh --model MODEL_ID
```

The provider defaults to `openai-responses`. No reasoning effort is sent unless `--reasoning` is specified. The helper also sets `HINDSIGHT_API_LLM_TEMPERATURE=none` and strict structured output.

Use `--provider openai` for a Chat Completions endpoint and `--base-url` for an OpenAI-compatible gateway. The helper requires a healthy app and at least one non-blank fact from a synthetic dry run. The dry run stores no facts. If verification fails, the helper restores the previous environment and checks app health again. If it cannot verify rollback, it reports the path to the protected backup and keeps that file.

## Other providers

Hindsight supports additional hosted and local providers. Configure their documented environment variables directly in the private `hindsight.env` file. Add host-specific mounts only through the ignored `deploy/compose/compose.local.yaml` file.

## Approval

Record provider, model, privacy, token ceiling, cost ceiling, and current prices:

```bash
scripts/create-import-approval.sh \
  MAX_INPUT_TOKENS \
  MAX_COST_USD \
  remote-redacted \
  INPUT_USD_PER_MILLION \
  OUTPUT_USD_PER_MILLION
```

The helper replaces the approval file atomically with mode `0600`. Review the approval before you start the importer. The helper writes only the primary route.

The importer checks the approval against the primary and indexed `HINDSIGHT_API_LLM_*` routes declared in its local `hindsight.env` metadata. It also checks that the server reports extraction support. The local route and privacy settings are operator declarations, not verification of the server's provider, model, or data location. Keep the metadata in sync with the service host. Use `local` only if all routes keep the data local. Use `remote-redacted` if any route sends data to a remote provider. The importer redacts the outbound data in either case.

Token reservations are cumulative across imports and session updates. They do not reset each month. Set `maxEstimatedInputTokens` to JSON `null` in the approval file to disable only the token ceiling, or pass `null` as the helper's first argument. This is useful for ongoing subscription-based imports. A positive safe integer sets a finite ceiling; a missing value is invalid. Accounting continues with either setting. Provider, model, privacy, cost, disk-space, and failure-rate checks remain enabled.

The importer reserves estimated input tokens and cost before each retain. Set `maxEstimatedCostUsd` and any token prices to finite, non-negative JSON numbers. The estimate defaults to zero when prices are omitted. A zero-dollar ceiling with no prices is not an actual spending limit. If you set `maxFailureRate`, use a JSON number greater than 0 and at most 1. If you set `continuousMinFailureSample`, use a positive safe integer.

The estimate is a guardrail, not a provider invoice. Prompt overhead and consolidation can increase actual use. Configure a provider-side budget or rate limit as well.

### Migrate an approval for failover

An existing single-route approval needs no change unless the local metadata declares indexed routes.

1. Back up the private `import-approval.json` file. Keep the current limits and prices unless you approve a change to them.
2. In the local `hindsight.env` metadata, record both `HINDSIGHT_API_LLM_<n>_PROVIDER` and `HINDSIGHT_API_LLM_<n>_MODEL` for each indexed route configured on the service. Do not copy provider credentials into the approval.
3. Add `alternateRoutes` to the existing approval. Replace the example IDs with the exact provider and model IDs you approve. Set `privacy` for all routes, including failover.

```json
{
  "alternateRoutes": [
    { "provider": "openai-responses", "model": "APPROVED_MODEL_ID" }
  ]
}
```

4. Save the updated approval with mode `0600` before you start the importer. If any indexed route has an incomplete declaration or no exact approval, the importer stops before durable import. The legacy `*` model match applies only to the primary route.

## Required sequence

```text
no-LLM smoke
→ provider configuration
→ standard bank configuration with auto-consolidation off
→ offline inventory
→ approval file
→ bounded two-mode pilot
→ reviewed pilot retention
→ historical import
```

Do not put API keys in Git, command arguments, shell history, Compose YAML, inventory reports, or import approval files.
