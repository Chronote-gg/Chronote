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

  test("upgrade page shows promo and canceled notices", () => {
    authState.state = "unauthenticated";
    setRouteSearch({ promo: "SAVE20", canceled: true });
    renderWithMantine(<Upgrade />);

    expect(screen.getByText(/promo unlocked/i)).toBeInTheDocument();
    expect(screen.getByText(/checkout canceled/i)).toBeInTheDocument();

    const login = screen.getByRole("link", {
      name: /connect discord to continue/i,
    });
    expect(login).toHaveAttribute(
      "href",
      expect.stringContaining("/auth/discord"),
    );
    expect(login).toHaveAttribute(
      "href",
      expect.stringContaining("promo%3DSAVE20"),
    );
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
    if (options && typeof options.search === "function") {
      expect(options.search({ promo: "SAVE20" })).toEqual({
        promo: "SAVE20",
        serverId: "g1",
      });
    } else {
      throw new Error("Expected navigate search updater");
    }
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
