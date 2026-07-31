import { createCache } from "async-cache-dedupe";
import Redis from "ioredis";
import { config } from "./configService";
import { isUsableRedisUrl } from "../utils/redisUrl";

const normalizePrefix = (value: string) => value.replace(/:+$/, "").trim();
const rawPrefix = normalizePrefix(config.cache.keyPrefix);
const cachePrefix = rawPrefix ? `${rawPrefix}:` : "";

export const buildCacheKey = (key: string) => `${cachePrefix}${key}`;

const cacheEnabled = config.cache.enabled;
// An unusable URL falls through to memory storage below rather than looping on
// a connection that cannot succeed.
const redisUrl = isUsableRedisUrl(config.cache.redisUrl)
  ? config.cache.redisUrl
  : "";

const redisClient =
  cacheEnabled && redisUrl
    ? new Redis(redisUrl, {
        enableReadyCheck: true,
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      })
    : null;

if (redisClient) {
  redisClient.on("error", (error) => {
    console.warn("Redis client error", error);
  });
}

const storage =
  cacheEnabled && redisClient
    ? {
        type: "redis" as const,
        options: {
          client: redisClient,
          invalidation: { referencesTTL: config.cache.referencesTtlSeconds },
        },
      }
    : {
        type: "memory" as const,
        options: {
          size: config.cache.memorySize,
          invalidation: config.cache.invalidationEnabled,
        },
      };

export const cache = createCache({
  storage,
  ttl: config.cache.defaultTtlSeconds,
  onError: (error) => {
    console.warn("Cache error", error);
  },
});

export const isCacheEnabled = cacheEnabled;

export const withCache = async <T>(
  label: string,
  cached: () => Promise<T>,
  fallback: () => Promise<T>,
  shouldFallback: (error: unknown) => boolean = () => true,
): Promise<T> => {
  if (!cacheEnabled) {
    return fallback();
  }
  try {
    return await cached();
  } catch (error) {
    console.warn(`${label} cache failure`, error);
    if (!shouldFallback(error)) {
      throw error;
    }
    return fallback();
  }
};
