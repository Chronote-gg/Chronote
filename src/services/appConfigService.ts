import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { config } from "./configService";

type AppConfigCache = {
  values: Record<string, unknown>;
  nextToken?: string;
  expiresAt: number;
};

let cache: AppConfigCache | null = null;
const isTestEnv =
  process.env.NODE_ENV === "test" || Boolean(process.env.JEST_WORKER_ID);

function isAppConfigEnabled() {
  if (isTestEnv) return false;
  return (
    config.appConfig.enabled &&
    config.appConfig.applicationId.length > 0 &&
    config.appConfig.environmentId.length > 0 &&
    config.appConfig.profileId.length > 0
  );
}

async function ensureSessionToken(
  client: AppConfigDataClient,
): Promise<string> {
  if (cache?.nextToken) return cache.nextToken;
  const session = await client.send(
    new StartConfigurationSessionCommand({
      ApplicationIdentifier: config.appConfig.applicationId,
      EnvironmentIdentifier: config.appConfig.environmentId,
      ConfigurationProfileIdentifier: config.appConfig.profileId,
    }),
  );
  if (!session.InitialConfigurationToken) {
    throw new Error("AppConfig session token missing.");
  }
  cache = {
    values: cache?.values ?? {},
    nextToken: session.InitialConfigurationToken,
    expiresAt: 0,
  };
  return session.InitialConfigurationToken;
}

function parsePayload(raw: string): { values: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw) as {
      values?: Record<string, unknown>;
    };
    return { values: parsed.values ?? {} };
  } catch (error) {
    console.warn("Failed to parse AppConfig payload:", error);
    return null;
  }
}

export async function getGlobalConfigValues(): Promise<
  Record<string, unknown>
> {
  if (config.mock.enabled && process.env.PW_VISUAL === "true") {
    // Visual regression snapshots are meant to reflect the production-like
    // global defaults we typically keep enabled, without requiring AppConfig
    // credentials in CI.
    return {
      "transcription.premium.enabled": true,
      "transcription.premium.cleanup.enabled": true,
    };
  }

  if (!isAppConfigEnabled()) return {};

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.values;
  }

  const client = new AppConfigDataClient({ region: config.storage.awsRegion });
  try {
    const token = await ensureSessionToken(client);
    const response = await client.send(
      new GetLatestConfigurationCommand({
        ConfigurationToken: token,
      }),
    );
    const nextToken = response.NextPollConfigurationToken ?? token;
    const pollSeconds =
      response.NextPollIntervalInSeconds ??
      Math.ceil(config.appConfig.cacheTtlMs / 1000);
    const expiresAt = now + pollSeconds * 1000;

    let values = cache?.values ?? {};
    if (response.Configuration) {
      const decoded = Buffer.from(response.Configuration).toString("utf-8");
      if (decoded.trim().length > 0) {
        const parsed = parsePayload(decoded);
        if (parsed) {
          values = parsed.values;
        }
      }
    }

    cache = {
      values,
      nextToken,
      expiresAt,
    };
    return values;
  } catch (error) {
    console.warn("AppConfig fetch failed, using cached values:", error);
    return cache?.values ?? {};
  }
}

export function resetAppConfigCache() {
  cache = null;
}
