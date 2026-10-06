import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import "./mocks/trpc";
import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { fireEvent, screen } from "@testing-library/react";
import PromoLanding from "../../src/frontend/pages/PromoLanding";
import Upgrade from "../../src/frontend/pages/Upgrade";
import UpgradeServerSelect from "../../src/frontend/pages/UpgradeServerSelect";
import UpgradeSuccess from "../../src/frontend/pages/UpgradeSuccess";
import Billing from "../../src/frontend/pages/Billing";
import {
  authState,
  guildState,
  navigateSpy,
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouteSearch,
} from "./testUtils";
import { setBillingQuery } from "./mocks/trpc";

describe("upgrade pages", () => {
  beforeEach(() => {
    resetFrontendMocks();
  });

  test("promo landing navigates to upgrade server select with promo", () => {
    authState.state = "authenticated";
    setRouteParams({ code: "SAVE20" });
    renderWithMantine(<PromoLanding />);

    const cta = screen.getByRole("button", { name: /choose a server/i });
    fireEvent.click(cta);

    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/upgrade/select-server",
      search: { promo: "SAVE20" },
    });
  });

  test("upgrade renders purchase content on its indexable route", () => {
    authState.state = "unauthenticated";
    setRouteSearch({ promo: "SAVE20", canceled: true });
    renderWithMantine(<Upgrade />);

    expect(
      screen.getByText("More time for your meetings."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).toBeNull();
    const login = screen.getByRole("link", { name: "Connect Discord" });
    expect(login.getAttribute("href")).toContain("promo%3DSAVE20");
  });

  test("upgrade success shows back to homepage for signed-out users", () => {
    authState.state = "unauthenticated";
    renderWithMantine(<UpgradeSuccess />);

    expect(
      screen.getByRole("button", { name: /back to homepage/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /manage billing/i }),
    ).toBeNull();
  });

  test("upgrade server select links back to checkout intent", () => {
    authState.state = "authenticated";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setRouteSearch({ promo: "SAVE20" });
    renderWithMantine(<UpgradeServerSelect />);

    const select = screen.getByTestId("upgrade-server-open");
    fireEvent.click(select);

    expect(navigateSpy).toHaveBeenCalled();
    const [call] = navigateSpy.mock.calls;
    const options = call?.[0];
    expect(options.search).toEqual({
      promo: "SAVE20",
      serverId: "g1",
      interval: "month",
      source: "direct",
    });
  });
});

describe("billing promo input", () => {
  beforeEach(() => {
    resetFrontendMocks();
  });

  test("prefills promo code from search params", () => {
    authState.state = "authenticated";
    guildState.selectedGuildId = "guild-1";
    guildState.guilds = [{ id: "guild-1", name: "Team One", canManage: true }];
    setRouteSearch({ promo: "SAVE20" });
    setBillingQuery({
      data: {
        billingEnabled: true,
        tier: "free",
        status: "free",
        nextBillingDate: null,
        usage: null,
      },
    });

    renderWithMantine(<Billing />);

    const input = screen.getByLabelText(/promo code/i) as HTMLInputElement;
    expect(input.value).toBe("SAVE20");
  });
});
