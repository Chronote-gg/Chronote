import React from "react";
import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithMantine, resetFrontendMocks } from "./testUtils";
import { guildState } from "./testUtils";
import {
  setAskConversationQuery,
  setAskListQuery,
  setAskSettingsQuery,
  setAskSharedConversationQuery,
  setAskSharedListQuery,
  feedbackSubmitAskMutation,
  trpcUtils,
} from "./mocks/trpc";
import { setRouteSearch } from "./mocks/routerState";
import * as askRun from "../../src/frontend/features/ask/useAskRun";
import Ask from "../../src/frontend/pages/Ask";

describe("Ask page", () => {
  beforeEach(() => {
    resetFrontendMocks();
  });

  test("prompts to select a server when none is selected", () => {
    guildState.selectedGuildId = null;
    setAskListQuery({ data: { conversations: [] } });
    renderWithMantine(<Ask />);
    expect(
      screen.getByText(/Select a server to ask questions/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ask-input")).toBeDisabled();
  });

  test("renders conversation messages for selected server", async () => {
    guildState.selectedGuildId = "g1";
    setRouteSearch({ conversationId: "c1" });
    setAskListQuery({
      data: {
        conversations: [
          {
            id: "c1",
            title: "Weekly sync",
            summary: "Team updates",
            createdAt: "2025-12-01T00:00:00.000Z",
            updatedAt: "2025-12-02T00:00:00.000Z",
          },
        ],
      },
    });
    setAskConversationQuery({
      data: {
        conversation: {
          id: "c1",
          title: "Weekly sync",
          summary: "Team updates",
          createdAt: "2025-12-01T00:00:00.000Z",
          updatedAt: "2025-12-02T00:00:00.000Z",
        },
        messages: [
          {
            id: "m1",
            role: "user",
            text: "What did we decide?",
            createdAt: "2025-12-02T12:00:00.000Z",
          },
          {
            id: "m2",
            role: "chronote",
            text: "You decided to ship next week.",
            createdAt: "2025-12-02T12:01:00.000Z",
          },
        ],
      },
    });

    renderWithMantine(<Ask />);

    await waitFor(() => {
      expect(screen.getAllByTestId("ask-message").length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("ask-rename")).toBeInTheDocument();
    expect(screen.getByText(/ship next week/i)).toBeInTheDocument();
  });

  test("submits feedback for an Ask answer", async () => {
    guildState.selectedGuildId = "g1";
    setRouteSearch({ conversationId: "c1" });
    setAskListQuery({
      data: {
        conversations: [
          {
            id: "c1",
            title: "Weekly sync",
            summary: "Team updates",
            createdAt: "2025-12-01T00:00:00.000Z",
            updatedAt: "2025-12-02T00:00:00.000Z",
          },
        ],
      },
    });
    setAskConversationQuery({
      data: {
        conversation: {
          id: "c1",
          title: "Weekly sync",
          summary: "Team updates",
          createdAt: "2025-12-01T00:00:00.000Z",
          updatedAt: "2025-12-02T00:00:00.000Z",
        },
        messages: [
          {
            id: "m1",
            role: "user",
            text: "What did we decide?",
            createdAt: "2025-12-02T12:00:00.000Z",
          },
          {
            id: "m2",
            role: "chronote",
            text: "You decided to ship next week.",
            createdAt: "2025-12-02T12:01:00.000Z",
          },
        ],
      },
    });

    renderWithMantine(<Ask />);

    await waitFor(() => {
      expect(screen.getByText(/ship next week/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Mark answer needs work/i));

    await waitFor(() => {
      expect(screen.getByText(/Ask feedback/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/What could be better/i), {
      target: { value: "Add decision details." },
    });
    fireEvent.click(screen.getByText(/Send feedback/i));

    await waitFor(() => {
      expect(feedbackSubmitAskMutation.mutateAsync).toHaveBeenCalledWith({
        serverId: "g1",
        conversationId: "c1",
        messageId: "m2",
        rating: "down",
        comment: "Add decision details.",
      });
    });
  });

  test("shows public share link when public sharing is enabled", async () => {
    guildState.selectedGuildId = "g1";
    setRouteSearch({ conversationId: "c1" });
    setAskSettingsQuery({
      data: { askMembersEnabled: true, askSharingPolicy: "public" },
    });
    setAskListQuery({
      data: {
        conversations: [
          {
            id: "c1",
            title: "Design notes",
            summary: "Design sync",
            createdAt: "2025-12-01T00:00:00.000Z",
            updatedAt: "2025-12-02T00:00:00.000Z",
            visibility: "public",
          },
        ],
      },
    });
    setAskConversationQuery({
      data: {
        conversation: {
          id: "c1",
          title: "Design notes",
          summary: "Design sync",
          createdAt: "2025-12-01T00:00:00.000Z",
          updatedAt: "2025-12-02T00:00:00.000Z",
          visibility: "public",
        },
        messages: [],
      },
    });

    renderWithMantine(<Ask />);

    await waitFor(() => {
      expect(screen.getByTestId("ask-share")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("ask-share"));

    const linkInput = (await screen.findByLabelText(
      "Public link",
    )) as HTMLInputElement;
    expect(linkInput.value).toContain("/share/ask/g1/c1");
    expect(screen.getByText("Make server-only")).toBeInTheDocument();
  });

  test("falls back to server share when public sharing is disabled", async () => {
    guildState.selectedGuildId = "g1";
    setRouteSearch({ conversationId: "c1" });
    setAskSettingsQuery({
      data: { askMembersEnabled: true, askSharingPolicy: "server" },
    });
    setAskListQuery({
      data: {
        conversations: [
          {
            id: "c1",
            title: "Launch plan",
            summary: "Launch notes",
            createdAt: "2025-12-01T00:00:00.000Z",
            updatedAt: "2025-12-02T00:00:00.000Z",
            visibility: "public",
          },
        ],
      },
    });
    setAskConversationQuery({
      data: {
        conversation: {
          id: "c1",
          title: "Launch plan",
          summary: "Launch notes",
          createdAt: "2025-12-01T00:00:00.000Z",
          updatedAt: "2025-12-02T00:00:00.000Z",
          visibility: "public",
        },
        messages: [],
      },
    });

    renderWithMantine(<Ask />);

    await waitFor(() => {
      expect(screen.getByTestId("ask-share")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("ask-share"));

    const linkInput = (await screen.findByLabelText(
      "Shared link",
    )) as HTMLInputElement;
    expect(linkInput.value).toContain("/portal/server/g1/ask");
    expect(linkInput.value).toContain("conversationId=c1");
    expect(linkInput.value).toContain("list=shared");
    expect(screen.queryByText("Make public")).not.toBeInTheDocument();
  });

  test("shows shared list mode as read only with owner", async () => {
    guildState.selectedGuildId = "g1";
    setRouteSearch({ conversationId: "c2", list: "shared" });
    setAskSettingsQuery({
      data: { askMembersEnabled: true, askSharingPolicy: "server" },
    });
    setAskSharedListQuery({
      data: {
        conversations: [
          {
            conversationId: "c2",
            title: "Incident follow-up",
            summary: "Follow-up notes",
            updatedAt: "2025-12-05T00:00:00.000Z",
            sharedAt: "2025-12-05T00:10:00.000Z",
            ownerUserId: "u2",
            ownerTag: "Grace Hopper",
          },
        ],
      },
    });
    setAskSharedConversationQuery({
      data: {
        conversation: {
          id: "c2",
          title: "Incident follow-up",
          summary: "Follow-up notes",
          createdAt: "2025-12-05T00:00:00.000Z",
          updatedAt: "2025-12-05T00:00:00.000Z",
          visibility: "server",
        },
        messages: [],
        shared: {
          conversationId: "c2",
          title: "Incident follow-up",
          summary: "Follow-up notes",
          updatedAt: "2025-12-05T00:00:00.000Z",
          sharedAt: "2025-12-05T00:10:00.000Z",
          ownerUserId: "u2",
          ownerTag: "Grace Hopper",
        },
      },
    });

    renderWithMantine(<Ask />);

    await waitFor(() => {
      expect(screen.getByText(/Shared by Grace Hopper/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Shared threads are read only/i),
    ).toBeInTheDocument();
  });
});

test("recovered run merges its final pair with cached history and refreshes canonical history", () => {
  resetFrontendMocks();
  guildState.selectedGuildId = "g1";
  setRouteSearch({ conversationId: "c1" });
  const conversation = {
    id: "c1",
    title: "History",
    summary: "",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
  };
  const oldMessage = {
    id: "older-answer",
    role: "chronote" as const,
    text: "Earlier answer remains",
    createdAt: "2026-01-01",
  };
  const finalPair = [
    {
      id: "latest-question",
      role: "user" as const,
      text: "Latest question",
      createdAt: "2026-01-02",
    },
    {
      id: "latest-answer",
      role: "chronote" as const,
      text: "Latest answer",
      createdAt: "2026-01-02",
    },
  ];
  setAskConversationQuery({ data: { conversation, messages: [oldMessage] } });
  setAskListQuery({ data: { conversations: [conversation] } });
  const recoveredResult = {
    conversationId: "c1",
    conversation,
    messages: finalPair,
  };
  const spy = jest.spyOn(askRun, "useAskRun").mockReturnValue({
    isPending: false,
    text: "",
    question: "",
    activity: undefined,
    recoveredResult,
    recoveryError: null,
    mutateAsync: async () => recoveredResult,
    stop: async () => undefined,
    reset: () => undefined,
  });
  try {
    renderWithMantine(<Ask />);
    const [, update] =
      trpcUtils.ask.getConversation.setData.mock.calls.at(-1) ?? [];
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== "function")
      throw new Error("Expected the history-preserving cache updater");
    expect(update({ conversation, messages: [oldMessage] }).messages).toEqual([
      oldMessage,
      ...finalPair,
    ]);
    expect(trpcUtils.ask.getConversation.invalidate).toHaveBeenCalledWith({
      serverId: "g1",
      conversationId: "c1",
    });
  } finally {
    spy.mockRestore();
  }
});
