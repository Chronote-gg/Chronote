/**
 * Single source for the Langfuse host so the app and the standalone scripts
 * cannot drift. They did: the prompt scripts hardcoded the US region while the
 * app left `baseUrl` empty and inherited the SDK's default (`cloud.langfuse.com`),
 * so with `LANGFUSE_BASE_URL` unset a US-region key returned 401 on every app
 * and eval call while `prompts:check` worked fine.
 *
 * Deliberately dependency free: `scripts/langfuse/client.ts` needs this without
 * importing `configService`, which validates the whole app config on load.
 */
export const DEFAULT_LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com";
