# Provider gate

Hindsight can store chunks without an LLM, but durable fact extraction and observation consolidation require an approved provider.

## OpenAI API key

Use the secure helper and select an available model explicitly:

```bash
scripts/configure-provider.sh --model MODEL_ID
```

The provider defaults to `openai-responses`. No reasoning effort is sent unless `--reasoning` is specified. The helper also sets `HINDSIGHT_API_LLM_TEMPERATURE=none` and strict structured output.

Use `--provider openai` for a Chat Completions endpoint and `--base-url` for an OpenAI-compatible gateway. Hindsight startup and extraction verification fail if the selected configuration is unavailable.

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

The importer checks that the approval provider and model equal the active server configuration. It transactionally reserves estimated input and cost before each retain.

The estimate is a guardrail, not a provider invoice. Prompt overhead and consolidation can increase actual use. Configure a provider-side budget or rate limit as well.

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
