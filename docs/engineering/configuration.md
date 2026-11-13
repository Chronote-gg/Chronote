# Configuration reference

## Configuration & env

- Central config: `src/services/configService.ts`; preferred source (avoid re-exporting secrets from `constants.ts`).
- Required always: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `OPENAI_API_KEY`.
- OAuth (optional): `ENABLE_OAUTH` (default true). `SESSION_SECRET` or `OAUTH_SECRET` is always required outside mock mode for session and CSRF signing. If OAuth is true, also require `DISCORD_CLIENT_SECRET` and `DISCORD_CALLBACK_URL`. If not using OAuth, set `ENABLE_OAUTH=false` (wired into Terraform env).
- Production OAuth should use the API domain callback (e.g., `https://api.chronote.gg/auth/discord/callback`). When `API_DOMAIN` is set in Terraform, the backend is behind an ALB and the frontend build uses `VITE_API_BASE_URL` from GitHub Actions env vars.
- Remote MCP (optional): `ENABLE_MCP` defaults true only when Discord OAuth is enabled, requires `OAUTH_SECRET`, and exposes `/mcp` on the API server. Set `MCP_PUBLIC_BASE_URL` to the externally reachable API origin for production so OAuth resource-bound tokens match the public endpoint. Optional overrides: `MCP_ENDPOINT_PATH`, `MCP_ACCESS_TOKEN_TTL_SECONDS`, `MCP_REFRESH_TOKEN_TTL_SECONDS`, `MCP_AUTH_CODE_TTL_SECONDS`.
- Notion export (optional): set `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, and `NOTION_REDIRECT_URI` to enable user OAuth, one-way export, manual sync, server automation, and personal automation from Chronote notes to Notion pages. Notion tokens are encrypted with `NOTION_TOKEN_ENCRYPTION_SECRET` when set, otherwise `OAUTH_SECRET`/`SESSION_SECRET`.
- OpenAI org/project IDs are optional (defaults empty).
- Text generation uses the Responses API through `services/openaiTextService.ts`; keep one request path and remove superseded transports when migrating callers. Audio transcription, speech and image generation use their dedicated endpoints. Preserve saved model/parameter/prompt snapshots, cancellation, mention guards and per-caller fallbacks. See `docs/superpowers/specs/2026-10-21-responses-meeting-evaluation-design.md`.
- `NOTES_MODEL` defaults to `gpt-6.1-sol` and controls notes generation only. `models.notes` can override it. Meeting summary, notes correction, transcription cleanup and image prompt roles keep independent `gpt-5.2` defaults through their existing `models.*` settings. Frozen DynamoDB v1 model, parameter and prompt snapshots remain authoritative for saved recordings.
- Notes default to low reasoning without temperature; honor compatible explicit
  `modelParams.notes.*` overrides. Notes requests using supported model profiles,
  including GPT-6.1 Sol, request explicit 30-minute cache control without
  breakpoints, including continuations. Older overrides omit unsupported cache
  fields. Preserve prompt and input ordering; static-prefix optimization needs a
  separate design. See `docs/adr-20261022-sol-notes-caching.md`.
- Langfuse prompt sync uses `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. Optional: `LANGFUSE_BASE_URL`, `LANGFUSE_PROMPT_LABEL`, `LANGFUSE_PROMPT_TRANSCRIPTION`, `LANGFUSE_PROMPT_DICTIONARY_TEACHING`. `LANGFUSE_BASE_URL` defaults to `https://us.cloud.langfuse.com` (`services/langfuseDefaults.ts`), shared by the app and the scripts so they cannot resolve to different hosts. An EU or self-hosted project must set it, or its keys reach the US host and every call returns 401.
- Optional Langfuse prompt override for the finalized audio pass: `LANGFUSE_PROMPT_TRANSCRIPTION_FINAL_PASS`.
- Langfuse MCP tooling: run `node scripts/setup-langfuse-mcp-auth.js` to write `.opencode/langfuse.mcp.auth` plus `.opencode/langfuse.public` and `.opencode/langfuse.secret` for OpenCode. The `langfuse_obs` OpenCode MCP uses uvx and reads those files; Codex and Claude Code still expect `LANGFUSE_MCP_AUTH` in the environment.
- Other env defaults: `PORT` (3001), `NODE_ENV`, Dynamo local toggles via `USE_LOCAL_DYNAMODB`.
- Worker identity: in ECS a worker's release is its task definition revision, read from `ECS_CONTAINER_METADATA_URI_V4`, and task protection goes through `ECS_AGENT_URI`. Outside ECS the release comes from `WORKER_RELEASE` (default 0). `BOT_INSTANCE_ID` optionally fixes the instance id outside ECS; in ECS it is ignored and every task picks a random one, so a value set in the task definition cannot give two tasks the same id. Without it each process picks a random one. `deploy.cjs rollout` removes `DEPLOYMENT_CANDIDATE_ID` from every new task definition revision, so workers run without it. See `docs/deployment.md`.
- Cloud dev bootstrap: run `./scripts/setup-cloud-dev.sh` to sync uv, install scc into `.bin/`, install lizard into `.venv/bin/`, and install Playwright browsers (no flags needed). Add `.bin` and `.venv/bin` to `PATH` for `yarn code:stats`.
- Mock-friendly env file: copy `scripts/mock.env.example` to `.env` or source it directly (`set -a; source scripts/mock.env.example; set +a`) instead of exporting many vars manually. The file keeps mock mode enabled, disables OAuth, points at local DynamoDB, and supplies dummy tokens.
- Transcript storage: set `TRANSCRIPTS_BUCKET` (required for S3 uploads), optional `TRANSCRIPTS_PREFIX`, `AWS_REGION` (defaults to `us-east-1`).
