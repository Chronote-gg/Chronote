# Langfuse LLM connection sync

This repo keeps Langfuse LLM connections in YAML so they can be reviewed and synced in CI.

## Location

- Connection files live in `langfuse/llm-connections/*.yml`.
- File name does not matter, `provider` is the primary key.

## YAML schema

```yaml
provider: openai
adapter: openai
secretKeyEnv: OPENAI_API_KEY
baseUrl: https://api.openai.com/v1
withDefaultModels: true
customModels:
  - gpt-6.1-sol
  - gpt-5.2
  - gpt-5.1
  - gpt-5-mini
extraHeadersEnv:
  OpenAI-Project: OPENAI_PROJECT_ID
environments:
  - prod
  - staging
```

Notes:

- `provider` must be unique per Langfuse project.
- `adapter` must be one of: `openai`, `azure`, `anthropic`, `bedrock`, `google-vertex-ai`, `google-ai-studio`.
- `secretKeyEnv` is recommended for secrets; `secretKey` is supported for local-only use.
- `extraHeadersEnv` maps header keys to env var names.
- `baseUrl` is optional, use it for OpenAI compatible proxies.
- `config` is required for Bedrock (`{ "region": "us-east-1" }`).
- `environments` is optional. If set, use `--env` or `LLM_CONNECTIONS_ENV` to filter.

## Bedrock example

```yaml
provider: bedrock
adapter: bedrock
secretKeyEnv: LANGFUSE_LLM_SECRET_BEDROCK
withDefaultModels: true
customModels:
  - anthropic.claude-3-5-sonnet-20240620-v1:0
config:
  region: us-east-1
```

Notes:

- Use model IDs that are supported in the configured region.

## Commands

```bash
yarn llm-connections:push
yarn llm-connections:pull
yarn llm-connections:check
```

Flags:

- `--dir <path>` to override the default directory.
- `--env <name>` to filter by `environments`.
- `--dry-run` for push and pull.
- `--limit <n>` for pull paging (clamped to 100).

## CI behavior

`yarn llm-connections:check` runs in CI using `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL`. It compares local YAML with
Langfuse without reading secrets or comparing their values. A PR that changes
connection YAML can report expected drift until the merged revision is synced.
Keep that failure visible in the PR description; do not change checks or push
live connections from a PR to clear it.

After a successful production backend deployment, `Sync OpenAI LLM Connection`
in `.github/workflows/deploy.yml` automatically syncs only
`langfuse/llm-connections/openai.yml` from the event revision. It copies that file
to a temporary directory, runs a dry run, pushes, and checks the result. The
directory is removed when the step exits. Prompt promotion remains a separate
job after the backend deployment.

The OpenAI upsert replaces the provider key and extra headers as well as the
model list. The job uses the existing production AWS identity to read
`AWSCURRENT` from Secrets Manager at `${SECRETS_PREFIX}/openai-api-key`.
If `SECRETS_PREFIX` is empty, it derives the prefix by removing `-bot-task` from
`ECS_TASK_FAMILY`, matching backend preflight. It resolves the current task
definition through `ECS_CLUSTER` and `ECS_SERVICE`, then reads `OPENAI_PROJECT_ID`
from the app container environment. It never selects the latest task-family
revision. The app container is the one with `DDB_TABLE_PREFIX`, matching the
deployment coordinator.

Both the key and project ID must be nonempty. Missing runtime configuration
fails the job before any push; the required `OpenAI-Project` header is never
dropped. Values are masked and exported only within that step, without
persisting them to Actions environment files, outputs, or artifacts. Langfuse
credentials and base URL use the same bindings as prompt promotion. No new
GitHub secrets or Terraform apply are needed.

Other providers, including Bedrock, remain explicitly managed with the existing
commands and provider credentials. The automatic job never includes their YAML.
Staging shares the Langfuse project with production and must not automatically
push connections. PR and staging workflows continue to check drift only.
