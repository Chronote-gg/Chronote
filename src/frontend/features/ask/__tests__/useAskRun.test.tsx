import { act, renderHook } from "@testing-library/react";
import { useAskRun } from "../useAskRun";

const completed = {
  conversationId: "conversation",
  conversation: {
    id: "conversation",
    title: "Question",
    summary: "",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  messages: [],
};
const snapshot = {
  runId: "run",
  requestId: "request",
  conversationId: "conversation",
  status: "running",
  question: "Question",
  text: "",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  result: completed,
};
const start = jest.fn();
const read = jest.fn();
const readByRequest = jest.fn();
const stop = jest.fn();
const unsubscribe = jest.fn();
let receive: (value: typeof snapshot) => void;
let disconnect: () => void;
const subscribe = jest.fn((_input, handlers) => {
  receive = handlers.onData;
  disconnect = handlers.onError;
  return { unsubscribe };
});
jest.mock("../../../services/trpc", () => ({
  trpc: {
    useUtils: () => ({
      client: {
        ask: {
          startRun: { mutate: start },
          getRun: { query: read },
          getRunByRequest: { query: readByRequest },
          stopRun: { mutate: stop },
          watchRun: { subscribe },
        },
      },
    }),
  },
}));

beforeEach(() => {
  sessionStorage.clear();
  jest.clearAllMocks();
  start.mockResolvedValue(snapshot);
  stop.mockResolvedValue(snapshot);
});

async function beginQuestion(result: {
  current: ReturnType<typeof useAskRun>;
}) {
  let pending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    pending = result.current.mutateAsync({
      serverId: "server",
      question: "Question",
    });
    await Promise.resolve();
  });
  return { pending };
}

test("streams answer text and stops the same run independently", async () => {
  const { result } = renderHook(() =>
    useAskRun({ userId: "user", serverId: "server", conversationId: null }),
  );
  const { pending } = await beginQuestion(result);
  act(() => receive({ ...snapshot, text: "An answer" }));
  expect(result.current.text).toBe("An answer");
  expect(result.current.isPending).toBe(true);
  await act(async () => {
    await result.current.stop();
  });
  expect(stop).toHaveBeenCalledWith({
    serverId: "server",
    conversationId: "conversation",
    runId: "run",
  });
  await act(async () => {
    receive({ ...snapshot, status: "completed" });
    await expect(pending).resolves.toEqual(completed);
  });
  expect(unsubscribe).toHaveBeenCalled();
  expect(result.current.isPending).toBe(false);
});

test("uncertain sends retain request and conversation identities on retry", async () => {
  start.mockRejectedValueOnce(new Error("Connection lost"));
  const { result } = renderHook(() =>
    useAskRun({ userId: "user", serverId: "server", conversationId: null }),
  );
  const input = { serverId: "server", question: "Question" };
  await act(async () => {
    await expect(result.current.mutateAsync(input)).rejects.toThrow(
      "Connection lost",
    );
  });
  start.mockResolvedValue({ ...snapshot, status: "completed" });
  await act(async () => {
    await result.current.mutateAsync(input);
  });
  expect(start.mock.calls[0][0]).toEqual(start.mock.calls[1][0]);
  expect(start.mock.calls[0][0].timezone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});

test("stream disconnect reads canonical saved state", async () => {
  read.mockResolvedValue({ ...snapshot, status: "completed" });
  const { result } = renderHook(() =>
    useAskRun({ userId: "user", serverId: "server", conversationId: null }),
  );
  const { pending } = await beginQuestion(result);
  await act(async () => {
    disconnect();
    await pending;
  });
  expect(read).toHaveBeenCalledWith({
    serverId: "server",
    conversationId: "conversation",
    runId: "run",
  });
});

test("scope changes detach old results and clear answer text", async () => {
  const { result, rerender } = renderHook(
    ({ scope }) =>
      useAskRun({ userId: "user", serverId: scope, conversationId: null }),
    {
      initialProps: { scope: "a" },
    },
  );
  let pending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    pending = result.current.mutateAsync({
      serverId: "a",
      question: "Question",
    });
    await Promise.resolve();
  });
  const rejected = expect(pending).rejects.toHaveProperty("name", "AbortError");
  rerender({ scope: "b" });
  await rejected;
  act(() => receive({ ...snapshot, text: "Old private text" }));
  expect(result.current.text).toBe("");
  expect(result.current.isPending).toBe(false);
});

test("reload resumes the saved identity without sending another question", async () => {
  sessionStorage.setItem(
    "chronote-ask-run:user:server:conversation",
    JSON.stringify({ runId: "run", requestId: "request" }),
  );
  read.mockResolvedValue(snapshot);
  const { result } = renderHook(() =>
    useAskRun({
      userId: "user",
      serverId: "server",
      conversationId: "conversation",
    }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(start).not.toHaveBeenCalled();
  expect(result.current.isPending).toBe(true);
  await act(async () => {
    receive({ ...snapshot, status: "completed" });
    await Promise.resolve();
  });
  expect(result.current.recoveredResult).toEqual(completed);
  expect(
    sessionStorage.getItem("chronote-ask-run:user:server:conversation"),
  ).toBeNull();
});

test("signout clears only the signed-in user's saved run identities", () => {
  const { rerender } = renderHook<
    ReturnType<typeof useAskRun>,
    { userId: string | null }
  >(
    ({ userId }) =>
      useAskRun({ userId, serverId: "server", conversationId: null }),
    { initialProps: { userId: "user" } },
  );
  sessionStorage.setItem(
    "chronote-ask-run:user:server:conversation",
    JSON.stringify({ runId: "run" }),
  );
  sessionStorage.setItem(
    "chronote-ask-run:other:server:conversation",
    JSON.stringify({ runId: "other" }),
  );
  rerender({ userId: null });
  expect(
    sessionStorage.getItem("chronote-ask-run:user:server:conversation"),
  ).toBeNull();
  expect(
    sessionStorage.getItem("chronote-ask-run:other:server:conversation"),
  ).not.toBeNull();
});

test("a lost start response followed by reload recovers its original run without a second send", async () => {
  start.mockRejectedValueOnce(new Error("Lost response"));
  const first = renderHook(() =>
    useAskRun({ userId: "user", serverId: "server", conversationId: null }),
  );
  await act(async () => {
    await expect(
      first.result.current.mutateAsync({
        serverId: "server",
        question: "Question",
      }),
    ).rejects.toThrow("Lost response");
  });
  const sent = start.mock.calls[0][0];
  const saved = JSON.parse(
    sessionStorage.getItem(
      `chronote-ask-run:user:server:${sent.conversationId}`,
    ) ?? "{}",
  );
  expect(saved).toEqual({ requestId: sent.requestId });
  first.unmount();
  readByRequest.mockResolvedValue(snapshot);
  const restored = renderHook(() =>
    useAskRun({ userId: "user", serverId: "server", conversationId: null }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(readByRequest).toHaveBeenCalledWith({
    serverId: "server",
    conversationId: sent.conversationId,
    requestId: sent.requestId,
  });
  expect(start).toHaveBeenCalledTimes(1);
  await act(async () => {
    receive({ ...snapshot, status: "completed" });
    await Promise.resolve();
  });
  expect(restored.result.current.recoveredResult).toEqual(completed);
});

test("an unknown send after reload keeps the outbound identities for deliberate retry", async () => {
  sessionStorage.setItem(
    "chronote-ask-run:user:server:new",
    "original-conversation",
  );
  sessionStorage.setItem(
    "chronote-ask-run:user:server:original-conversation",
    JSON.stringify({ requestId: "original-request" }),
  );
  readByRequest.mockResolvedValue(null);
  const { result } = renderHook(() =>
    useAskRun({ userId: "user", serverId: "server", conversationId: null }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.recoveryError).toContain(
    "previous send is unconfirmed",
  );
  expect(start).not.toHaveBeenCalled();
  start.mockResolvedValue({ ...snapshot, status: "completed" });
  await act(async () => {
    await result.current.mutateAsync({
      serverId: "server",
      question: "Question",
    });
  });
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationId: "original-conversation",
      requestId: "original-request",
    }),
  );
});
