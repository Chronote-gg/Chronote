import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { observable } from "@trpc/server/observable";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "../../trpc/router";
import { AuthProvider, useAuth } from "./AuthContext";
import { ProtectedSessionBoundary } from "../components/ProtectedSessionBoundary";
import { useAuthNavigationBlocker } from "../hooks/useAuthNavigationBlocker";
import * as recovery from "../services/authRecovery";
import { MantineProvider } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { fireEvent } from "@testing-library/react";
import { PersonalMeetingShareModal } from "../features/meetingShares/PersonalMeetingShareModal";
import { trpc } from "../services/trpc";
import { queryClient } from "../queryClient";
import {
  authRecoveryLink,
  setAuthRequestsAllowed,
} from "../services/authRecovery";

jest.mock("../services/analytics", () => ({
  identifyUser: jest.fn(),
  resetAnalyticsIdentity: jest.fn(),
}));
let actor: { id: string; username: string; avatar: null } | null;
let identityError = false;
let identityReads = 0;
let protectedDenied = false;
let mutationRequests = 0;
let latest: ReturnType<typeof useAuth>;
function Probe() {
  latest = useAuth();
  return <div>{latest.state}</div>;
}
const terminal: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      if (op.path === "auth.me") identityReads++;
      if (op.type === "mutation") mutationRequests++;
      queueMicrotask(() => {
        if (
          (op.path === "auth.me" && identityError) ||
          (op.path !== "auth.me" && (!actor || protectedDenied))
        ) {
          observer.error(
            TRPCClientError.from<AppRouter>({
              error: {
                message: "fixture failure",
                code: -32001,
                data: {
                  code: identityError
                    ? "INTERNAL_SERVER_ERROR"
                    : "UNAUTHORIZED",
                  httpStatus: identityError ? 500 : 401,
                },
              },
            }),
          );
          return;
        }
        observer.next({
          result: { data: op.path === "auth.me" ? actor : { guilds: [] } },
        });
        observer.complete();
      });
    });
const setup = (children?: ReactNode) => {
  const client = trpc.createClient({ links: [authRecoveryLink, terminal] });
  render(
    <MantineProvider>
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Probe />
            {children}
          </AuthProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </MantineProvider>,
  );
  return client;
};
beforeEach(() => {
  actor = { id: "fixture-a", username: "fixture", avatar: null };
  identityError = false;
  identityReads = 0;
  protectedDenied = false;
  mutationRequests = 0;
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  setAuthRequestsAllowed(true);
});
afterEach(() => queryClient.clear());

test("private entry rechecks stale identity without requiring a page reload", async () => {
  setup();
  await screen.findByText("authenticated");
  actor = null;
  await act(async () => {
    queryClient.setQueryData(
      [["auth", "me"], { type: "query" }],
      { ...latest.user, username: "stale-fixture" },
      {
        updatedAt: Date.now() - 60_000,
      },
    );
  });
  await waitFor(() => expect(latest.user?.username).toBe("stale-fixture"));
  await act(async () => latest.ensureProtectedSession());
  await screen.findByText("unauthenticated");
  expect(identityReads).toBe(2);
});

test("parallel protected rejections reconcile once and do not replay the failed operations", async () => {
  const client = setup();
  await waitFor(() => expect(latest.protectedQueriesReady).toBe(true));
  actor = null;
  await act(async () => {
    await Promise.allSettled([
      client.servers.listEligible.query(),
      client.servers.listEligible.query(),
    ]);
  });
  await screen.findByText("unauthenticated");
  expect(identityReads).toBe(2);
});

test("a successful manual mutation retry ends its episode without replaying the failed write", async () => {
  const client = setup();
  await waitFor(() => expect(latest.protectedQueriesReady).toBe(true));
  const save = () =>
    client.personalUploads.completeUpload.mutate({
      uploadId: "fixture",
      key: "fixture-key",
      uploadToken: "fixture-token",
    });
  protectedDenied = true;
  await act(async () => {
    await save().catch(() => undefined);
  });
  expect(identityReads).toBe(2);
  expect(mutationRequests).toBe(1);
  protectedDenied = false;
  await act(async () => {
    await save();
  });
  expect(mutationRequests).toBe(2);
  actor = null;
  await act(async () => {
    await client.servers.listEligible.query().catch(() => undefined);
  });
  await waitFor(() => expect(identityReads).toBe(3));
  expect(latest.state).toBe("unauthenticated");
});

test("an unavailable auth check is not a signed-out session even with retained user data", async () => {
  setup();
  await screen.findByText("authenticated");
  identityError = true;
  await act(async () => latest.refresh());
  await screen.findByText("unavailable");
  expect(latest.protectedQueriesReady).toBe(false);
});

test("an unavailable private entry stays unavailable without automatic repeated checks", async () => {
  identityError = true;
  setup(
    <ProtectedSessionBoundary>
      <div>private content</div>
    </ProtectedSessionBoundary>,
  );
  await screen.findByText("We couldn't check your sign-in");
  expect(latest.state).toBe("unavailable");
  expect(identityReads).toBe(1);
});

test("personal share recipients survive expiry and an incoming grants reset", async () => {
  const client = setup(
    <ProtectedSessionBoundary>
      <PersonalMeetingShareModal
        opened
        onClose={() => {}}
        meetingTitle="Fixture meeting"
        accessGrants={[]}
        saving={false}
        error={null}
        onSave={() => {}}
      />
    </ProtectedSessionBoundary>,
  );
  const recipients = await screen.findByLabelText("User IDs");
  fireEvent.change(recipients, { target: { value: "123456789012345678" } });
  expect(latest.navigationBlocked).toBe(true);
  actor = null;
  await act(async () => {
    await client.servers.listEligible.query().catch(() => undefined);
  });
  await screen.findByText("Continue to sign in");
  expect(screen.getByLabelText("User IDs")).toHaveValue("123456789012345678");
});

function Draft() {
  const [value, setValue] = useState("");
  useAuthNavigationBlocker(value.length > 0);
  return (
    <input
      aria-label="Draft"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
    />
  );
}
function QueriedDraft() {
  trpc.servers.listEligible.useQuery(undefined, { retry: false });
  return <Draft />;
}

async function setupDraft() {
  const client = setup(
    <ProtectedSessionBoundary>
      <Draft />
    </ProtectedSessionBoundary>,
  );
  return { client, draft: await screen.findByLabelText("Draft") };
}

test("repeated stream outages preserve the page and leave the session-rejection budget unused", async () => {
  const navigate = jest
    .spyOn(recovery, "navigateToDiscord")
    .mockImplementation(() => {});
  try {
    const { client, draft } = await setupDraft();
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () =>
        recovery.reportAuthCheck(recovery.getAuthRequestGeneration()),
      );
      await waitFor(() => expect(identityReads).toBe(attempt + 2));
      expect(latest.state).toBe("authenticated");
      expect(screen.getByLabelText("Draft")).toBe(draft);
    }
    expect(navigate).not.toHaveBeenCalled();
    actor = null;
    await act(async () => {
      await client.servers.listEligible.query().catch(() => undefined);
    });
    await waitFor(() => expect(identityReads).toBe(4));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  } finally {
    navigate.mockRestore();
  }
});
test("a resumed read that still rejects ends recovery after one identity check", async () => {
  setup(
    <ProtectedSessionBoundary>
      <QueriedDraft />
    </ProtectedSessionBoundary>,
  );
  fireEvent.change(await screen.findByLabelText("Draft"), {
    target: { value: "Fixture retained draft" },
  });
  protectedDenied = true;
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: [["servers", "listEligible"]],
    });
  });
  await waitFor(() => expect(latest.state).toBe("recovery-required"));
  expect(identityReads).toBe(2);
  expect(screen.getByLabelText("Draft")).toHaveValue("Fixture retained draft");
});
test("expiry preserves a real local draft before offering to leave for sign-in", async () => {
  const navigate = jest
    .spyOn(recovery, "navigateToDiscord")
    .mockImplementation(() => {});
  try {
    const { client, draft } = await setupDraft();
    fireEvent.change(draft, { target: { value: "fixture unsaved edit" } });
    actor = null;
    await act(async () => {
      await client.servers.listEligible.query().catch(() => undefined);
    });
    await screen.findByText("Continue to sign in");
    expect(screen.getByLabelText("Draft")).toHaveValue("fixture unsaved edit");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Stay here"));
    expect(screen.getByLabelText("Draft")).toHaveValue("fixture unsaved edit");
    await expect(client.servers.listEligible.query()).rejects.toThrow(
      "Sign-in is paused",
    );
  } finally {
    navigate.mockRestore();
  }
});

test("a signed-out private entry makes one automatic attempt and preserves its target", async () => {
  actor = null;
  window.history.replaceState({}, "", "/portal/meetings?scope=personal#notes");
  const navigate = jest
    .spyOn(recovery, "navigateToDiscord")
    .mockImplementation(() => {});
  try {
    setup(
      <ProtectedSessionBoundary>
        <div>private content</div>
      </ProtectedSessionBoundary>,
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const target = new URL(navigate.mock.calls[0][0], window.location.href);
    expect(target.searchParams.get("redirect")).toBe(window.location.href);
    expect(screen.queryByText("private content")).not.toBeInTheDocument();
  } finally {
    navigate.mockRestore();
  }
});
