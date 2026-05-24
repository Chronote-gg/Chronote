import React from "react";
import {
  getRouteSearch,
  navigateSpy,
  routeParams,
  routerState,
  setRouteSearch,
  subscribeRouteSearch,
} from "./routerState";

type RouteSearch = {
  meetingId?: string;
  eventId?: string;
  fullScreen?: boolean | string;
  list?: string;
  conversationId?: string;
  messageId?: string;
  promo?: string;
  serverId?: string;
  plan?: string;
  interval?: string;
  canceled?: boolean | string;
  session_id?: string;
};

type NavigateOptions = {
  search?: RouteSearch | ((prev: RouteSearch) => RouteSearch);
};

const buildSearchString = () => {
  const params = new URLSearchParams();
  Object.entries(getRouteSearch()).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  return query ? `?${query}` : "";
};

const resolveRouteId = (pathname: string) => {
  if (
    pathname.startsWith("/portal/meetings/") &&
    pathname !== "/portal/meetings"
  ) {
    return "/portal/meetings/$serverId/$meetingId";
  }
  if (pathname.startsWith("/portal/server/")) {
    if (pathname.endsWith("/ask")) return "/portal/server/$serverId/ask";
    if (pathname.endsWith("/library"))
      return "/portal/server/$serverId/library";
    if (pathname.endsWith("/billing"))
      return "/portal/server/$serverId/billing";
    if (pathname.endsWith("/settings"))
      return "/portal/server/$serverId/settings";
    return "/portal/server/$serverId";
  }
  return pathname;
};

const buildRouterState = () => ({
  location: {
    pathname: routerState.pathname,
    search: buildSearchString(),
  },
  matches: [
    {
      routeId: resolveRouteId(routerState.pathname),
    },
  ],
});

const navigate = (options?: NavigateOptions) => {
  navigateSpy(options);
  if (!options || options.search === undefined) {
    return;
  }
  const prev = getRouteSearch();
  const nextSearch =
    typeof options.search === "function"
      ? options.search({ ...prev })
      : options.search;
  setRouteSearch(nextSearch ?? {});
};

jest.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => (
    <span data-testid="navigate" data-to={to} />
  ),
  Outlet: () => <div data-testid="router-outlet" />,
  useNavigate: () => navigate,
  useParams: () => routeParams,
  useSearch: () =>
    React.useSyncExternalStore(
      subscribeRouteSearch,
      getRouteSearch,
      getRouteSearch,
    ),
  useRouterState: (options?: {
    select?: (state: ReturnType<typeof buildRouterState>) => unknown;
  }) => {
    const state = buildRouterState();
    return options?.select ? options.select(state) : state;
  },
}));
