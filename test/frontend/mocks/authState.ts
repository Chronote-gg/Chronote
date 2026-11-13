export type MockAuthState = {
  state:
    | "unknown"
    | "authenticated"
    | "unauthenticated"
    | "unavailable"
    | "recovery-required"
    | "recovering";
  loginUrl: string;
  logoutUrl: string;
  loading: boolean;
  protectedQueriesReady: boolean;
  actorKey: number;
  navigationBlocked: boolean;
  ensureProtectedSession: () => Promise<void>;
  retryRecovery: () => Promise<void>;
  continueRecovery: () => void;
  onPublicNavigation: () => void;
  refresh: () => Promise<void>;
  user?: {
    id?: string;
    username?: string;
    avatar?: string | null;
    isSuperAdmin?: boolean;
  } | null;
};

const defaultLoginUrl = "https://example.com/login";
const defaultLogoutUrl = "https://example.com/logout";

export const authState: MockAuthState = {
  state: "unauthenticated",
  loginUrl: defaultLoginUrl,
  logoutUrl: defaultLogoutUrl,
  loading: false,
  protectedQueriesReady: true,
  actorKey: 0,
  navigationBlocked: false,
  ensureProtectedSession: async () => {},
  retryRecovery: async () => {},
  continueRecovery: () => {},
  onPublicNavigation: () => {},
  refresh: async () => {},
  user: null,
};

export const resetAuthState = () => {
  authState.state = "unauthenticated";
  authState.loginUrl = defaultLoginUrl;
  authState.logoutUrl = defaultLogoutUrl;
  authState.loading = false;
  authState.protectedQueriesReady = true;
  authState.actorKey = 0;
  authState.navigationBlocked = false;
  authState.ensureProtectedSession = async () => {};
  authState.retryRecovery = async () => {};
  authState.continueRecovery = () => {};
  authState.onPublicNavigation = () => {};
  authState.refresh = async () => {};
  authState.user = null;
};
