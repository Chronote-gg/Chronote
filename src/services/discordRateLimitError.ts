export const DISCORD_RATE_LIMIT_ERROR_NAME = "DiscordRateLimitedError";

export class DiscordRateLimitedError extends Error {
  constructor(message = "Discord rate limited. Please retry.") {
    super(message);
    this.name = DISCORD_RATE_LIMIT_ERROR_NAME;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isDiscordRateLimitedError = (
  error: unknown,
): error is DiscordRateLimitedError => {
  if (error instanceof DiscordRateLimitedError) return true;
  if (!isRecord(error)) return false;
  return error.name === DISCORD_RATE_LIMIT_ERROR_NAME;
};
