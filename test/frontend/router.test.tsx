import React from "react";
import { describe, expect, test, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";

type RouteOptions = {
  path?: string;
  component?: React.ComponentType;
};

class MockRoute {
  path?: string;
  component?: React.ComponentType;
  children: MockRoute[];

  constructor(options: RouteOptions) {
    this.path = options.path;
    this.component = options.component;
    this.children = [];
  }

  addChildren(children: MockRoute[]) {
    this.children = children;
    return this;
  }
}

class MockRootRoute extends MockRoute {}

class MockRouter {
  routeTree: MockRoute;

  constructor(options: { routeTree: MockRoute }) {
    this.routeTree = options.routeTree;
  }
}

type MockGuildState = {
  selectedGuildId: string | null;
  guilds: { id: string; canManage?: boolean }[];
};
type MockPortalState = { lastServerId: string | null };

const guildState: MockGuildState = { selectedGuildId: null, guilds: [] };
const portalState: MockPortalState = { lastServerId: null };

jest.mock("@tanstack/react-router", () => ({
  RootRoute: MockRootRoute,
  Route: MockRoute,
  Router: MockRouter,
  Outlet: () => <div data-testid="outlet" />,
  Navigate: ({
    to,
    params,
  }: {
    to: string;
    params?: { serverId?: string };
  }) => (
    <div
      data-testid="navigate"
      data-to={to}
      data-server={params?.serverId ?? ""}
    />
  ),
  lazyRouteComponent: () => () => <div data-testid="lazy-route" />,
}));

jest.mock("../../src/frontend/contexts/GuildContext", () => ({
  useGuildContext: () => guildState,
}));

jest.mock("../../src/frontend/stores/portalStore", () => ({
  usePortalStore: (
    selector: (state: { lastServerId: string | null }) => string | null,
  ) => selector(portalState),
}));

import { router } from "../../src/frontend/router";

describe("router", () => {
  test("portal index redirects to My Meetings", () => {
    const portalRoute = router.routeTree.children.find(
      (child) => child.path === "portal",
    );
    if (!portalRoute) {
      throw new Error("Missing portal route");
    }
    const portalIndex = portalRoute.children.find(
      (child) => child.path === "/",
    );
    if (!portalIndex || !portalIndex.component) {
      throw new Error("Missing portal index route");
    }
    const PortalIndexComponent = portalIndex.component;
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", canManage: true }];
    portalState.lastServerId = "g2";
    render(<PortalIndexComponent />);
    const node = screen.getByTestId("navigate");
    expect(node).toHaveAttribute("data-to", "/portal/meetings");
    expect(node).toHaveAttribute("data-server", "");
  });

  test("portal includes direct meeting detail route", () => {
    const portalRoute = router.routeTree.children.find(
      (child) => child.path === "portal",
    );
    if (!portalRoute) {
      throw new Error("Missing portal route");
    }
    const detailRoute = portalRoute.children.find(
      (child) => child.path === "meetings/$serverId/$meetingId",
    );
    expect(detailRoute).toBeDefined();
  });
});
