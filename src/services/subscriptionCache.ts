type CacheEntry = { value: unknown; expiresAt: number };

const cache = new Map<string, CacheEntry>();

export function getCachedGuildSubscription<T>(guildId: string): T | undefined {
  const entry = cache.get(guildId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(guildId);
    return undefined;
  }
  return entry.value as T;
}

export function setCachedGuildSubscription<T>(
  guildId: string,
  value: T,
  expiresAt: number,
) {
  if (expiresAt <= Date.now()) {
    cache.delete(guildId);
    return;
  }
  cache.set(guildId, { value, expiresAt });
}

export function clearGuildSubscriptionCache(guildId?: string) {
  if (guildId) {
    cache.delete(guildId);
    return;
  }
  cache.clear();
}
