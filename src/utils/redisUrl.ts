// Hosts where a plaintext Redis connection is legitimate. docker-compose runs
// redis:8-alpine with no TLS for local development.
const LOCAL_CACHE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "redis"]);

// `redis:` and `rediss:` are not special schemes, so the WHATWG parser keeps the
// host verbatim: it does not lowercase it, and it leaves IPv6 literals in their
// brackets. Both would miss the allowlist above and quietly demote a working
// local Redis to the memory cache.
const normalizeHost = (hostname: string) =>
  hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");

/**
 * Managed Redis (Upstash, ElastiCache) accepts TLS only, and ioredis decides
 * whether to negotiate TLS from the URL scheme alone. A `redis://` URL pointed
 * at one of them therefore connects in plaintext, gets its socket reset, and
 * retries forever rather than failing, which starves every cache-backed request
 * instead of degrading. Upstash's console shows `redis-cli --tls -u redis://...`,
 * where the TLS comes from the flag and not the scheme, so copying that string
 * verbatim produces exactly this.
 *
 * Returning false here drops the cache to its in-process memory storage, which
 * is slower but correct, instead of entering that loop.
 */
export function isUsableRedisUrl(url: string): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error("Cache disabled: REDIS_URL is not a valid URL.");
    return false;
  }

  // A truncated secret such as "rediss://" parses with an empty hostname, and
  // ioredis would then retry a connection that can never resolve. That is the
  // same loop this guard exists to prevent, so check the host before the scheme.
  const hostname = normalizeHost(parsed.hostname);
  if (!hostname) {
    console.error("Cache disabled: REDIS_URL has no host.");
    return false;
  }

  if (parsed.protocol === "rediss:") return true;
  if (LOCAL_CACHE_HOSTS.has(hostname)) return true;

  console.error(
    `Cache disabled: REDIS_URL uses ${parsed.protocol}// for remote host ${parsed.hostname}. ` +
      "Managed Redis requires TLS, so the scheme must be rediss://.",
  );
  return false;
}
