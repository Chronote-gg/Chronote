export type MockAuthState = {
  state: "unknown" | "authenticated" | "unauthenticated";
  loginUrl: string;
  logoutUrl: string;
  loading: boolean;
  protectedQueriesReady: boolean;
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
  refresh: async () => {},
  user: null,
};

export const resetAuthState = () => {
  authState.state = "unauthenticated";
  authState.loginUrl = defaultLoginUrl;
  authState.logoutUrl = defaultLogoutUrl;
  authState.loading = false;
  authState.protectedQueriesReady = true;
  authState.refresh = async () => {};
  authState.user = null;
};
