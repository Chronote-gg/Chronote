/**
 * The Langfuse host used whenever `LANGFUSE_BASE_URL` is unset, shared by the
 * app config and the standalone scripts so the two cannot resolve to different
 * endpoints.
 *
 * This is US region, which is not the SDK's own default. An unset variable has
 * to resolve here rather than fall through to the SDK, or credentials for a US
 * project are sent to the wrong host and every call returns 401. A deployment
 * in another region must set `LANGFUSE_BASE_URL` explicitly.
 *
 * Dependency free on purpose: `scripts/langfuse/client.ts` needs this without
 * importing `configService`, which validates the whole app config on load.
 */
export const DEFAULT_LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com";

/**
 * The single way to turn `LANGFUSE_BASE_URL` into a host. Trims first, so a
 * blank or whitespace-only value falls back rather than being sent to the SDK
 * as an endpoint. Every caller must use this: two call sites deciding the
 * fallback separately is what let the app and the scripts diverge.
 */
export const resolveLangfuseBaseUrl = (raw?: string): string => {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LANGFUSE_BASE_URL;
};
