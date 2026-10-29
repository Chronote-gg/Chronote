import "./mocks/mockAuthContext";
import "./mocks/trpc";
import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import {
  GuildProvider,
  useGuildContext,
} from "../../src/frontend/contexts/GuildContext";
import { authState, resetAuthState } from "./mocks/authState";
import { resetTrpcMocks, setGuildQuery } from "./mocks/trpc";

type GuildSnapshot = {
  selectedGuildId: string | null;
  guilds: Array<{ id: string; name: string }>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

function GuildProbe({
  onCapture,
}: {
  onCapture: (value: GuildSnapshot) => void;
}) {
  const value = useGuildContext();
  onCapture(value);
  return (
    <div
      data-testid="guild-state"
      data-selected={value.selectedGuildId ?? ""}
      data-count={String(value.guilds.length)}
      data-loading={value.loading ? "true" : "false"}
      data-error={value.error ?? ""}
    />
  );
}

describe("GuildContext", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAuthState();
    resetTrpcMocks();
  });

  test("clears stored guild when unauthenticated", async () => {
    authState.state = "unauthenticated";
    localStorage.setItem("mn-selected-guild", "g1");
    setGuildQuery({
      data: { guilds: [{ id: "g1", name: "Guild One" }] },
      error: null,
    });

    render(
      <GuildProvider>
        <GuildProbe onCapture={() => {}} />
      </GuildProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("guild-state")).toHaveAttribute(
        "data-error",
        "auth",
      );
    });
    const node = screen.getByTestId("guild-state");
    expect(node).toHaveAttribute("data-selected", "");
    expect(node).toHaveAttribute("data-count", "0");
    expect(localStorage.getItem("mn-selected-guild")).toBeNull();
  });

  test("clears stale selection when user leaves guild", async () => {
    authState.state = "authenticated";
    localStorage.setItem("mn-selected-guild", "g1");
    setGuildQuery({
      data: { guilds: [{ id: "g2", name: "Guild Two" }] },
      error: null,
    });

    render(
      <GuildProvider>
        <GuildProbe onCapture={() => {}} />
      </GuildProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("guild-state")).toHaveAttribute(
        "data-selected",
        "",
      );
    });
    expect(localStorage.getItem("mn-selected-guild")).toBeNull();
  });

  test("sets auth error on unauthorized responses", async () => {
    authState.state = "authenticated";
    setGuildQuery({
      data: null,
      error: { data: { code: "UNAUTHORIZED" } },
    });

    render(
      <GuildProvider>
        <GuildProbe onCapture={() => {}} />
      </GuildProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("guild-state")).toHaveAttribute(
        "data-error",
        "auth",
      );
    });
  });
});

test("account transitions hide previous guild metadata and clear stored selection before queries resume", async () => {
  resetTrpcMocks();
  resetAuthState();
  localStorage.clear();
  localStorage.setItem("mn-selected-guild", "old");
  authState.state = "authenticated";
  authState.user = { id: "old-user" };
  authState.protectedQueriesReady = true;
  setGuildQuery({
    data: { guilds: [{ id: "old", name: "Old private server" }] },
  });
  const view = render(
    <GuildProvider>
      <GuildProbe onCapture={() => {}} />
    </GuildProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("guild-state")).toHaveAttribute(
      "data-count",
      "1",
    ),
  );
  authState.user = { id: "new-user" };
  authState.protectedQueriesReady = false;
  view.rerender(
    <GuildProvider>
      <GuildProbe onCapture={() => {}} />
    </GuildProvider>,
  );
  expect(screen.getByTestId("guild-state")).toHaveAttribute("data-count", "0");
  expect(screen.getByTestId("guild-state")).toHaveAttribute(
    "data-selected",
    "",
  );
  expect(localStorage.getItem("mn-selected-guild")).toBeNull();
  setGuildQuery({ data: { guilds: [{ id: "new", name: "New server" }] } });
  authState.protectedQueriesReady = true;
  view.rerender(
    <GuildProvider>
      <GuildProbe onCapture={() => {}} />
    </GuildProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("guild-state")).toHaveAttribute(
      "data-count",
      "1",
    ),
  );
  expect(screen.getByTestId("guild-state")).toHaveAttribute(
    "data-selected",
    "",
  );
});
