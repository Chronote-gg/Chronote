const resolveFrontendOrigin = (siteUrl: string): string | undefined => {
  const trimmed = siteUrl.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
};

const isSafeRedirectPath = (value: string) =>
  value.startsWith("/") && !value.startsWith("//");

type RedirectOptions = {
  allowedInternalPaths?: string[];
};

const isAllowedInternalPath = (value: string, allowedPaths: string[]) =>
  allowedPaths.some(
    (path) =>
      value === path ||
      value.startsWith(`${path}?`) ||
      value.startsWith(`${path}#`),
  );

export const resolveRedirectTarget = (
  rawRedirect: unknown,
  siteUrl: string,
  options: RedirectOptions = {},
): string | undefined => {
  if (typeof rawRedirect !== "string") return undefined;
  const trimmed = rawRedirect.trim();
  if (!trimmed) return undefined;

  const origin = resolveFrontendOrigin(siteUrl);
  if (!origin) return undefined;

  if (
    isSafeRedirectPath(trimmed) &&
    isAllowedInternalPath(trimmed, options.allowedInternalPaths ?? [])
  ) {
    return trimmed;
  }

  if (isSafeRedirectPath(trimmed)) {
    return new URL(trimmed, origin).toString();
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.origin !== origin) return undefined;
    return new URL(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
      origin,
    ).toString();
  } catch {
    return undefined;
  }
};
