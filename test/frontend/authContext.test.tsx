import "./mocks/trpc";
import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { AuthProvider, useAuth } from "../../src/frontend/contexts/AuthContext";
import { authQuery, resetTrpcMocks, setAuthQuery } from "./mocks/trpc";

type AuthSnapshot = {
  state: string;
  loading: boolean;
  loginUrl: string;
  logoutUrl: string;
  refresh: () => Promise<void>;
};

function AuthProbe({
  onCapture,
}: {
  onCapture: (value: AuthSnapshot) => void;
}) {
  const value = useAuth();
  onCapture(value);
  return (
    <div
      data-testid="auth-state"
      data-state={value.state}
      data-loading={value.loading ? "true" : "false"}
      data-login={value.loginUrl}
      data-logout={value.logoutUrl}
    />
  );
}

function AuthProbeWithBump({
  onCapture,
  onBumpReady,
}: {
  onCapture: (value: AuthSnapshot) => void;
  onBumpReady: (bump: () => void) => void;
}) {
  const value = useAuth();
  const [, setTick] = React.useState(0);
  const bump = React.useCallback(() => {
    setTick((current) => current + 1);
  }, []);
  onBumpReady(bump);
  onCapture(value);
  return (
    <div
      data-testid="auth-state"
      data-state={value.state}
      data-loading={value.loading ? "true" : "false"}
      data-login={value.loginUrl}
      data-logout={value.logoutUrl}
    />
  );
}

const resetAuthContext = () => {
  resetTrpcMocks();
  window.history.pushState({}, "", "/");
};

describe("AuthContext unauthenticated", () => {
  beforeEach(resetAuthContext);

  test("reports unauthenticated state and builds login url", async () => {
    setAuthQuery({ data: null, isLoading: false });
    let captured: AuthSnapshot | null = null;
    render(
      <AuthProvider>
        <AuthProbe
          onCapture={(value) => {
            captured = value;
          }}
        />
      </AuthProvider>,
    );
    const node = screen.getByTestId("auth-state");
    expect(node).toHaveAttribute("data-state", "unauthenticated");
    expect(node).toHaveAttribute("data-loading", "false");
    const loginUrl = node.getAttribute("data-login");
    if (!loginUrl) {
      throw new Error("Missing login url");
    }
    const resolved = new URL(loginUrl, window.location.origin);
    expect(resolved.pathname).toBe("/auth/discord");
    expect(resolved.searchParams.get("redirect")).toBe(
      `${window.location.origin}/portal`,
    );
    const logoutUrl = node.getAttribute("data-logout");
    if (!logoutUrl) {
      throw new Error("Missing logout url");
    }
    const logoutResolved = new URL(logoutUrl, window.location.origin);
    expect(logoutResolved.pathname).toBe("/logout");
    expect(logoutResolved.searchParams.get("redirect")).toBe(
      window.location.href,
    );
    if (!captured) {
      throw new Error("Missing auth snapshot");
    }
    await act(async () => {
      await captured.refresh();
    });
    expect(authQuery.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("AuthContext navigation", () => {
  beforeEach(resetAuthContext);

  test("uses current location for portal redirect targets", () => {
    setAuthQuery({ data: null, isLoading: false });
    window.history.pushState(
      {},
      "",
      "/portal/server/g1/library?meetingId=meeting-1#section-1",
    );
    render(
      <AuthProvider>
        <AuthProbe onCapture={() => {}} />
      </AuthProvider>,
    );
    const node = screen.getByTestId("auth-state");
    const loginUrl = node.getAttribute("data-login");
    if (!loginUrl) {
      throw new Error("Missing login url");
    }
    const resolved = new URL(loginUrl, window.location.origin);
    expect(resolved.searchParams.get("redirect")).toBe(window.location.href);
    const logoutUrl = node.getAttribute("data-logout");
    if (!logoutUrl) {
      throw new Error("Missing logout url");
    }
    const logoutResolved = new URL(logoutUrl, window.location.origin);
    expect(logoutResolved.searchParams.get("redirect")).toBe(
      window.location.href,
    );
  });

  test("refreshes login url after navigation without provider rerender", () => {
    setAuthQuery({ data: null, isLoading: false });
    let bump: (() => void) | null = null;
    render(
      <AuthProvider>
        <AuthProbeWithBump
          onCapture={() => {}}
          onBumpReady={(value) => {
            bump = value;
          }}
        />
      </AuthProvider>,
    );
    window.history.pushState(
      {},
      "",
      "/portal/server/g1/library?meetingId=meeting-2",
    );
    if (!bump) {
      throw new Error("Missing rerender callback");
    }
    act(() => {
      bump?.();
    });
    const node = screen.getByTestId("auth-state");
    const loginUrl = node.getAttribute("data-login");
    if (!loginUrl) {
      throw new Error("Missing login url");
    }
    const resolved = new URL(loginUrl, window.location.origin);
    expect(resolved.searchParams.get("redirect")).toBe(window.location.href);
    const logoutUrl = node.getAttribute("data-logout");
    if (!logoutUrl) {
      throw new Error("Missing logout url");
    }
    const logoutResolved = new URL(logoutUrl, window.location.origin);
    expect(logoutResolved.searchParams.get("redirect")).toBe(
      window.location.href,
    );
  });
});

describe("AuthContext authenticated", () => {
  beforeEach(resetAuthContext);

  test("reports authenticated when data is present", () => {
    setAuthQuery({ data: { id: "user-1" }, isLoading: false });
    render(
      <AuthProvider>
        <AuthProbe onCapture={() => {}} />
      </AuthProvider>,
    );
    expect(screen.getByTestId("auth-state")).toHaveAttribute(
      "data-state",
      "authenticated",
    );
  });
});
