import React from "react";
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, screen } from "@testing-library/react";
import {
  authState,
  guildState,
  navigateSpy,
  renderWithMantine,
  resetFrontendMocks,
} from "./testUtils";
import AuthBanner from "../../src/frontend/components/AuthBanner";
import EvidenceCard from "../../src/frontend/components/EvidenceCard";
import FeatureCard from "../../src/frontend/components/FeatureCard";
import FormSelect from "../../src/frontend/components/FormSelect";
import MeetingCard from "../../src/frontend/components/MeetingCard";
import MetricCard from "../../src/frontend/components/MetricCard";
import PageHeader from "../../src/frontend/components/PageHeader";
import PricingCard from "../../src/frontend/components/PricingCard";
import Section from "../../src/frontend/components/Section";
import SiteFooter from "../../src/frontend/components/SiteFooter";
import SiteHeader from "../../src/frontend/components/SiteHeader";
import SiteNavbar from "../../src/frontend/components/SiteNavbar";
import Surface from "../../src/frontend/components/Surface";

let mediaQueryMatches = false;
let computedScheme: "dark" | "light" = "dark";
const toggleColorScheme = jest.fn();

jest.mock("@mantine/hooks", () => {
  const actual = jest.requireActual("@mantine/hooks");
  return {
    ...actual,
    useMediaQuery: () => mediaQueryMatches,
  };
});

jest.mock("@mantine/core", () => {
  const actual = jest.requireActual("@mantine/core");
  return {
    ...actual,
    useComputedColorScheme: () => computedScheme,
    useMantineColorScheme: () => ({ toggleColorScheme }),
  };
});

describe("frontend components", () => {
  beforeEach(() => {
    resetFrontendMocks();
    mediaQueryMatches = false;
    computedScheme = "dark";
    toggleColorScheme.mockClear();
  });

  test("renders AuthBanner with default copy", () => {
    renderWithMantine(<AuthBanner />);
    expect(
      screen.getByText(/Connect your Discord account/i),
    ).toBeInTheDocument();
    const matches = screen.getAllByText("Connect Discord");
    const link = matches.find((node) => node.closest("a"))?.closest("a");
    if (!link) {
      throw new Error("Expected Connect Discord link");
    }
    expect(link).toHaveAttribute("href", "https://example.com/login");
  });

  test("renders basic card components", () => {
    renderWithMantine(
      <>
        <EvidenceCard quote="Great notes" speaker="Alex" />
        <FeatureCard title="Transcripts" description="Auto capture" icon="*" />
        <MetricCard label="Meetings" value="12" helper="Monthly" trend="+4" />
        <PageHeader title="Library" description="Recent meetings" badge="New" />
      </>,
    );
    expect(screen.getByText(/Great notes/)).toBeInTheDocument();
    expect(screen.getByText("Transcripts")).toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  test("renders MetricCard and PageHeader without optional fields", () => {
    renderWithMantine(
      <>
        <MetricCard label="Sessions" value="0" />
        <PageHeader title="Overview" />
      </>,
    );
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.queryByText("Monthly")).toBeNull();
    expect(screen.queryByText("New")).toBeNull();
  });

  test("renders EvidenceCard without meta line when details are empty", () => {
    renderWithMantine(<EvidenceCard quote="Just the facts" speaker="" />);
    expect(screen.getByText(/Just the facts/i)).toBeInTheDocument();
    expect(screen.queryByText((text) => text.includes("•"))).toBeNull();
  });

  test("renders FormSelect with password manager ignore attrs", () => {
    const { container } = renderWithMantine(
      <FormSelect label="Plan" data={["Basic", "Pro"]} />,
    );
    const input =
      container.querySelector("input[type='hidden']") ||
      container.querySelector("input");
    expect(input).toBeTruthy();
    expect(input).toHaveAttribute("data-lpignore", "true");
  });

  test("renders Surface tone variants", () => {
    renderWithMantine(
      <>
        <Surface data-testid="surface-default" />
        <Surface data-testid="surface-soft" tone="soft" />
        <Surface data-testid="surface-raised" tone="raised" />
      </>,
    );
    const defaultSurface = screen.getByTestId("surface-default");
    const softSurface = screen.getByTestId("surface-soft");
    const raisedSurface = screen.getByTestId("surface-raised");
    expect(defaultSurface.style.backgroundColor).not.toBe("");
    expect(softSurface.style.backgroundColor).not.toBe("");
    expect(softSurface.style.backgroundColor).not.toBe(
      defaultSurface.style.backgroundColor,
    );
    expect(raisedSurface.style.boxShadow).not.toBe("");
  });

  test("renders MeetingCard and triggers action", () => {
    const onOpen = jest.fn();
    renderWithMantine(
      <MeetingCard
        meeting={{
          id: "m1",
          title: "Kickoff",
          summary: "Project scope",
          dateLabel: "Jan 1",
          durationLabel: "30m",
          tags: ["alpha", "beta"],
          channel: "#general",
        }}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByText("View"));
    expect(onOpen).toHaveBeenCalledWith("m1");
  });

  test("renders PricingCard with highlight and notes", () => {
    renderWithMantine(
      <PricingCard
        name="Pro"
        price="$20"
        description="Full access"
        features={["Unlimited meetings"]}
        cta="Upgrade"
        highlighted
        note="Best choice"
      />,
    );
    expect(screen.getByText("Best value")).toBeInTheDocument();
    expect(screen.getByText("Upgrade")).toBeInTheDocument();
    expect(screen.getByText("Best choice")).toBeInTheDocument();
  });

  test("renders Section with eyebrow and description", () => {
    renderWithMantine(
      <Section
        title="Highlights"
        eyebrow="Overview"
        description="Summary"
        align="center"
      >
        <div>Child</div>
      </Section>,
    );
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
  });

  test("renders SiteFooter variants", () => {
    renderWithMantine(<SiteFooter />);
    expect(screen.getByText(/Chronote by/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "BASICBIT" })).toBeInTheDocument();
    renderWithMantine(<SiteFooter variant="compact" />);
  });

  test("renders SiteHeader CTA and theme toggle", () => {
    authState.state = "authenticated";
    renderWithMantine(
      <SiteHeader navbarOpened={false} onNavbarToggle={() => {}} />,
    );
    expect(screen.getByTestId("portal-cta")).toHaveAttribute("to", "/portal");
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  test("renders SiteHeader portal variants and navbar toggle states", () => {
    authState.state = "authenticated";
    authState.user = { username: "TestUser" };
    computedScheme = "light";
    mediaQueryMatches = true;

    const { unmount } = renderWithMantine(
      <SiteHeader
        navbarOpened
        showNavbarToggle
        onNavbarToggle={() => {}}
        context="portal"
      />,
    );
    expect(screen.getByText("Switch server")).toBeInTheDocument();
    expect(screen.getByTestId("portal-cta")).toHaveAttribute(
      "to",
      "/portal/select-server",
    );
    expect(screen.getByLabelText("Close navigation")).toBeInTheDocument();
    const logoutButton = screen.getByTestId("logout-cta");
    expect(logoutButton).toHaveAttribute("href", authState.logoutUrl);
    expect(screen.getByLabelText("Switch account")).toBeInTheDocument();
    unmount();

    renderWithMantine(
      <SiteHeader
        navbarOpened={false}
        showNavbarToggle
        onNavbarToggle={() => {}}
        context="portal-select"
      />,
    );
    expect(screen.queryByTestId("portal-cta")).toBeNull();
    expect(screen.getByLabelText("Open navigation")).toBeInTheDocument();
    expect(screen.getByTestId("logout-cta")).toBeInTheDocument();
  });

  test("renders SiteHeader unauthenticated CTA and disabled state", () => {
    authState.state = "unauthenticated";
    authState.loading = true;
    computedScheme = "dark";
    renderWithMantine(
      <SiteHeader
        navbarOpened={false}
        showNavbarToggle={false}
        onNavbarToggle={() => {}}
      />,
    );
    const cta = screen.getByTestId("portal-cta");
    expect(cta).toHaveTextContent("Open portal");
    const disabledAttr =
      cta.getAttribute("data-disabled") || cta.getAttribute("aria-disabled");
    expect(disabledAttr).toBe("true");
  });

  test("renders SiteNavbar navigation for authenticated users", () => {
    authState.state = "authenticated";
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    const openSpy = jest.spyOn(window, "open").mockImplementation(() => null);

    renderWithMantine(<SiteNavbar pathname="/portal/server/g1/library" />);
    expect(screen.getByText("Guild One")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-ask"));
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/portal/server/g1/ask",
    });
    fireEvent.click(screen.getByTestId("nav-support"));
    expect(openSpy).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  test("SiteNavbar falls back to server select when no guild is selected", () => {
    authState.state = "authenticated";
    computedScheme = "light";
    guildState.selectedGuildId = null;
    guildState.guilds = [];
    const onClose = jest.fn();

    renderWithMantine(
      <SiteNavbar pathname="/portal/server/unknown/ask" onClose={onClose} />,
    );

    expect(screen.getByText("Choose a server")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-ask"));
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/portal/select-server" });
    expect(onClose).toHaveBeenCalled();
  });

  test("SiteNavbar disables nav items when unauthenticated", () => {
    authState.state = "unauthenticated";
    guildState.selectedGuildId = null;
    guildState.guilds = [];

    renderWithMantine(<SiteNavbar pathname="/portal/server/g1/library" />);
    const navLibrary = screen.getByTestId("nav-library");
    const disabledAttr =
      navLibrary.getAttribute("data-disabled") ||
      navLibrary.getAttribute("aria-disabled");
    expect(disabledAttr).toBe("true");
  });
});
