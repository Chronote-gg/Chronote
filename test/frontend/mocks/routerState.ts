import { jest } from "@jest/globals";

type Listener = () => void;
const searchListeners = new Set<Listener>();

export const navigateSpy = jest.fn();
export const routerState = {
  pathname: "/",
};
export const routeParams: {
  serverId?: string;
  meetingId?: string;
  conversationId?: string;
  code?: string;
} = {};
let routeSearch: {
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
} = {};

export const getRouteSearch = () => routeSearch;

export const subscribeRouteSearch = (listener: Listener) => {
  searchListeners.add(listener);
  return () => {
    searchListeners.delete(listener);
  };
};

export const notifyRouteSearch = () => {
  searchListeners.forEach((listener) => listener());
};

export const resetNavigateSpy = () => {
  navigateSpy.mockClear();
};

export const resetRouterState = () => {
  routerState.pathname = "/";
  routeParams.serverId = undefined;
  routeParams.meetingId = undefined;
  routeParams.conversationId = undefined;
  routeParams.code = undefined;
  routeSearch = {};
  notifyRouteSearch();
};

export const setRouterPathname = (pathname: string) => {
  routerState.pathname = pathname;
};

export const setRouteParams = (params: {
  serverId?: string;
  meetingId?: string;
  conversationId?: string;
  code?: string;
}) => {
  routeParams.serverId = params.serverId;
  routeParams.meetingId = params.meetingId;
  routeParams.conversationId = params.conversationId;
  routeParams.code = params.code;
};

export const setRouteSearch = (search: {
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
}) => {
  routeSearch = { ...routeSearch, ...search };
  notifyRouteSearch();
};
