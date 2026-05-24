import React, { createContext, useContext, useMemo } from "react";
import { buildApiUrl } from "../services/apiClient";
import { trpc } from "../services/trpc";

type AuthState = "unknown" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  state: AuthState;
  loading: boolean;
  loginUrl: string;
  logoutUrl: string;
  refresh: () => Promise<void>;
  user?: {
    id: string;
    username: string;
    avatar: string | null;
    isSuperAdmin?: boolean;
  } | null;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const getBrowserLocation = (): Location | undefined =>
  typeof window === "undefined" ? undefined : window.location;

const resolvePortalRedirect = (location?: Location) => {
  if (!location) {
    return "/portal";
  }
  const pathname = location.pathname;
  const useCurrentLocation =
    pathname.startsWith("/portal") ||
    pathname.startsWith("/live") ||
    pathname.startsWith("/share") ||
    pathname.startsWith("/admin");
  if (useCurrentLocation) {
    return location.href;
  }
  return `${location.origin}/portal`;
};

const resolveLogoutRedirect = (location?: Location) => {
  if (!location) {
    return "/";
  }
  return location.href;
};

const buildLoginUrl = (location?: Location) =>
  `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    resolvePortalRedirect(location),
  )}`;

const buildLogoutUrl = (location?: Location) =>
  `${buildApiUrl("/logout")}?redirect=${encodeURIComponent(
    resolveLogoutRedirect(location),
  )}`;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const authQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
  });
  const loading = authQuery.isLoading;
  const state: AuthState = loading
    ? "unknown"
    : authQuery.data
      ? "authenticated"
      : "unauthenticated";

  const loginUrl = buildLoginUrl(getBrowserLocation());
  const logoutUrl = buildLogoutUrl(getBrowserLocation());

  const refetch = authQuery.refetch;
  const value = useMemo(
    () => ({
      state,
      loading,
      loginUrl,
      logoutUrl,
      user: authQuery.data ?? null,
      refresh: async () => {
        await refetch();
      },
    }),
    [state, loading, loginUrl, logoutUrl, refetch, authQuery.data],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  const loginUrl = buildLoginUrl(getBrowserLocation());
  const logoutUrl = buildLogoutUrl(getBrowserLocation());
  return useMemo(
    () =>
      loginUrl === ctx.loginUrl && logoutUrl === ctx.logoutUrl
        ? ctx
        : { ...ctx, loginUrl, logoutUrl },
    [ctx, loginUrl, logoutUrl],
  );
}
