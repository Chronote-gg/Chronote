import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useSyncExternalStore,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildApiUrl } from "../services/apiClient";
import { trpc } from "../services/trpc";
import { identifyUser, resetAnalyticsIdentity } from "../services/analytics";
import {
  cancelMeetingSessionQueries,
  resumeMeetingSessionQueries,
  resetMeetingSessionQueries,
} from "../queryClient";
import {
  advanceAuthRequestGeneration,
  setAuthRequestGeneration,
  setAuthRequestsAllowed,
  subscribeAuthTransport,
  createRecoveryUrl,
  readRecoveryAttempt,
  clearRecoveryAttempt,
  readRecoveryOutcome,
  removeRecoveryOutcome,
  navigateToDiscord,
  hasAuthNavigationBlockers,
  subscribeAuthNavigationBlockers,
} from "../services/authRecovery";

type AuthState =
  | "unknown"
  | "authenticated"
  | "unauthenticated"
  | "unavailable"
  | "recovery-required"
  | "recovering";

type AuthContextValue = {
  state: AuthState;
  loading: boolean;
  protectedQueriesReady: boolean;
  actorKey: number;
  navigationBlocked: boolean;
  ensureProtectedSession: () => Promise<void>;
  retryRecovery: () => Promise<void>;
  onPublicNavigation: () => void;
  continueRecovery: (options?: {
    interactive?: boolean;
    discardWork?: boolean;
  }) => void;
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
    pathname === "/join" ||
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

type RecoveryState =
  "idle" | "checking" | "required" | "recovering" | "unavailable";
function resolveAuthState(
  loading: boolean,
  recovery: RecoveryState,
  unavailable: boolean,
  authenticated: boolean,
): AuthState {
  if (loading) return "unknown";
  if (recovery === "required") return "recovery-required";
  if (recovery === "recovering") return "recovering";
  if (recovery === "unavailable" || unavailable) return "unavailable";
  return authenticated ? "authenticated" : "unauthenticated";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const authQuery = trpc.auth.me.useQuery(undefined, { retry: false });
  const [initialGeneration] = useState(advanceAuthRequestGeneration);
  const requestGeneration = useRef(initialGeneration);
  const [recovery, setRecovery] = useState<RecoveryState>(() =>
    readRecoveryOutcome() === "failed" ? "required" : "idle",
  );
  const navigationBlocked = useSyncExternalStore(
    subscribeAuthNavigationBlockers,
    hasAuthNavigationBlockers,
    () => false,
  );
  const check = useRef<Promise<void> | null>(null);
  const episodeChecked = useRef(false);
  const episodePath = useRef<string | null>(null);
  const departing = useRef(false);
  const loading = authQuery.isLoading || recovery === "checking";
  const state = resolveAuthState(
    loading,
    recovery,
    Boolean(authQuery.error),
    Boolean(authQuery.data),
  );
  const actor = authQuery.isLoading ? undefined : (authQuery.data?.id ?? null);
  const transition = useRef({ actor, generation: 0 });
  const retainedActor = useRef<string | null>(null);
  const actorKey = useRef(0);
  if (actor && actor !== retainedActor.current) {
    retainedActor.current = actor;
    actorKey.current++;
  }
  if (transition.current.actor !== actor) {
    transition.current = {
      actor,
      generation: transition.current.generation + 1,
    };
    requestGeneration.current = advanceAuthRequestGeneration();
  }
  setAuthRequestGeneration(requestGeneration.current);
  const generation = transition.current.generation;
  const [readyGeneration, setReadyGeneration] = useState<number>();
  const protectedQueriesReady =
    state === "authenticated" && readyGeneration === generation;
  setAuthRequestsAllowed(protectedQueriesReady);

  useEffect(() => {
    removeRecoveryOutcome();
    return () => setAuthRequestsAllowed(true);
  }, []);
  useEffect(() => {
    if (actor === undefined) return;
    let current = true;
    const reset =
      actor === null && hasAuthNavigationBlockers()
        ? cancelMeetingSessionQueries()
        : resetMeetingSessionQueries();
    void reset.then(() => {
      if (current) setReadyGeneration(generation);
    });
    return () => {
      current = false;
    };
  }, [actor, generation]);

  const refetch = authQuery.refetch;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const reconcile = useCallback((): Promise<void> => {
    if (check.current) return check.current;
    if (episodeChecked.current) {
      setRecovery("required");
      return Promise.resolve();
    }
    episodeChecked.current = true;
    requestGeneration.current = advanceAuthRequestGeneration();
    setAuthRequestsAllowed(false);
    setRecovery("checking");
    const pending = (async () => {
      await cancelMeetingSessionQueries();
      const result = await refetch();
      if (result.error) {
        setRecovery("unavailable");
        return;
      }
      check.current = null;
      setRecovery("idle");
      if (result.data) {
        setAuthRequestsAllowed(true);
        await resumeMeetingSessionQueries();
      }
    })()
      .catch(() => setRecovery("unavailable"))
      .finally(() => {
        check.current = null;
      });
    check.current = pending;
    return pending;
  }, [refetch]);

  useEffect(
    () =>
      subscribeAuthTransport((event) => {
        if (event.generation !== requestGeneration.current) return;
        if (event.kind === "authorized-read") {
          if (
            episodePath.current === null ||
            episodePath.current === event.path
          ) {
            episodeChecked.current = false;
            episodePath.current = null;
            clearRecoveryAttempt();
          }
        } else {
          episodePath.current ??= event.path;
          void reconcile();
        }
      }),
    [reconcile],
  );

  const ensureProtectedSession = useCallback(async () => {
    if (authQuery.isLoading || authQuery.error) return;
    const attempt = readRecoveryAttempt();
    if (attempt) {
      const canonical = (path: string) =>
        path.replace(/\/$/, "").replace(/^\/portal$/, "/portal/meetings");
      if (
        canonical(
          new URL(attempt.destination, window.location.origin).pathname,
        ) !== canonical(window.location.pathname)
      ) {
        clearRecoveryAttempt();
        episodeChecked.current = false;
        episodePath.current = null;
        setRecovery("idle");
      }
    }
    if (!authQuery.error && Date.now() - authQuery.dataUpdatedAt < 30_000)
      return;
    await reconcile();
  }, [
    authQuery.isLoading,
    authQuery.error,
    authQuery.dataUpdatedAt,
    reconcile,
  ]);
  const retryRecovery = useCallback(async () => {
    episodeChecked.current = false;
    await reconcile();
  }, [reconcile]);
  const onPublicNavigation = useCallback(() => {
    clearRecoveryAttempt();
    episodeChecked.current = false;
    episodePath.current = null;
    setRecovery("idle");
  }, []);
  const continueRecovery = useCallback(
    (options: { interactive?: boolean; discardWork?: boolean } = {}) => {
      if (
        departing.current ||
        (hasAuthNavigationBlockers() && !options.discardWork)
      )
        return;
      const url = createRecoveryUrl(
        buildLoginUrl(getBrowserLocation()),
        options.interactive,
      );
      if (!url) {
        setRecovery("required");
        return;
      }
      departing.current = true;
      setRecovery("recovering");
      navigateToDiscord(url);
    },
    [],
  );

  const retainedUser = useRef(authQuery.data);
  if (authQuery.data) retainedUser.current = authQuery.data;
  const userId = authQuery.data?.id;
  const wasAuthenticated = useRef(false);
  useEffect(() => {
    if (state === "authenticated" && userId) {
      identifyUser(userId);
      wasAuthenticated.current = true;
    } else if (state === "unauthenticated" && wasAuthenticated.current) {
      resetAnalyticsIdentity();
      wasAuthenticated.current = false;
    }
  }, [state, userId]);
  const loginUrl = buildLoginUrl(getBrowserLocation());
  const logoutUrl = buildLogoutUrl(getBrowserLocation());
  const value: AuthContextValue = {
    state,
    loading,
    protectedQueriesReady,
    actorKey: actorKey.current,
    navigationBlocked,
    loginUrl,
    logoutUrl,
    user:
      authQuery.data ??
      (navigationBlocked ? retainedUser.current : null) ??
      null,
    refresh,
    ensureProtectedSession,
    retryRecovery,
    continueRecovery,
    onPublicNavigation,
  };
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
