import React, { createContext, useContext, useMemo } from "react";
import { buildApiUrl } from "../services/apiClient";
import { trpc } from "../services/trpc";

type AuthState = "unknown" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  state: AuthState;
  loading: boolean;
  loginUrl: string;
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
    return "/portal/select-server";
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
  return `${location.origin}/portal/select-server`;
};

const buildLoginUrl = (location?: Location) =>
  `${buildApiUrl("/auth/discord")}?redirect=${encodeURIComponent(
    resolvePortalRedirect(location),
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

  const refetch = authQuery.refetch;
  const value = useMemo(
    () => ({
      state,
      loading,
      loginUrl,
      user: authQuery.data ?? null,
      refresh: async () => {
        await refetch();
      },
    }),
    [state, loading, loginUrl, refetch, authQuery.data],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  const loginUrl = buildLoginUrl(getBrowserLocation());
  return useMemo(
    () => (loginUrl === ctx.loginUrl ? ctx : { ...ctx, loginUrl }),
    [ctx, loginUrl],
  );
}
