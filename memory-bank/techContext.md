# Tech Context (Dec 18, 2025)

## Core stack

- **Language/Runtime**: TypeScript on Node.js 22.12; yarn 1.22.
- **Discord**: discord.js 14.16; discord-api-types; @discordjs/voice 0.18; @discordjs/opus; prism-media.
- **Audio**: fluent-ffmpeg with system ffmpeg; libsodium-wrappers; PCM/Opus handling; silence detection; MP3 splitting for Discord limits.
- **AI**: openai 5.x; gpt-4o-transcribe for ASR; gpt-5.1 for notes/corrections; gpt-5-mini for live gate; responder model configurable; DALL-E 3 for images; TTS via `gpt-4o-mini-tts`.
- **Backend web**: Express 5; express-session (Dynamo SessionTable); passport + passport-discord (optional OAuth).
- **Billing**: Stripe 14.24; checkout + billing portal; webhook verifies signature and now handles payment_failed + subscription_deleted; stores GuildSubscription/PaymentTransaction in Dynamo.
- **Storage/Data**: DynamoDB tables (GuildSubscription, PaymentTransaction, AccessLogs, RecordingTranscript, AutoRecordSettings, ServerContext, ChannelContext, MeetingHistory, SessionTable with TTL on `expiresAt`, InstallerTable, OnboardingStateTable, ConfigOverridesTable); S3 bucket for transcripts/audio.
- **Resilience**: cockatiel (retry/circuit breaker), bottleneck (rate limiting).
- **Infra/IaC**: Terraform (AWS: VPC, ECS/Fargate, ECR, Dynamo tables, KMS, CloudWatch logs, transcripts bucket, frontend bucket + CloudFront w/ OAC, SPA fallback). Checkov for IaC scanning.
- **Configuration**: AWS AppConfig for global config values, DynamoDB ConfigOverridesTable for scoped overrides (global/server/etc.).
- **Frontend**: Vite + React 19 + Mantine 8 UI; TanStack Router/Query + tRPC + Zustand; marketing at `/` and authenticated portal under `/portal/*`; static deploy to S3/CloudFront; testing via RTL/Jest.

## Tooling & commands

- Builds: `yarn build` (backend), `yarn build:web` (frontend), `yarn build:all`.
- Dev: `yarn start` (nodemon + ts-node), `yarn dev` (local Dynamo up + init + bot), `yarn frontend:dev`.
- Quality gates: `yarn run check` (eslint --fix, prettier --write, jest, backend build, Vite build); `yarn run check:ci` (lint:check, prettier:check, jest, builds).
- Lint/format: ESLint 8.57 + typescript-eslint 8.50; Prettier 3.5.
- Tests: Jest 29 with ts-jest; unit tests for tags, embed pagination, transcribe; frontend smoke tests.

## Notable conventions / constraints

- Central config via `src/services/configService.ts`; avoid exporting secrets from `constants.ts`.
- Express routes expect `Promise<void>` handlers; return after responses.
- Live voice gate returns only a boolean; no fallback; temperature/max_tokens not supported on gpt-5-mini.
- Short-lived session and in-memory caches reduce Discord API calls for guild lists, channels, roles, and members. Discord API requests use `cockatiel` retries with exponential backoff (max 3 attempts).
- Shared helpers belong in `src/utils`; use `src/utils/time.ts` for ISO conversion, duration formatting, and long date labels, and add unit tests when utilities are reused.
- Thinking cue loops until TTS playback begins; interval configurable (`LIVE_VOICE_THINKING_CUE_INTERVAL_MS`).
- ECS service SG currently allows wide egress temporarily for voice debug; must be tightened later.
- Frontend is static via CloudFront; APIs served by Express separately.
