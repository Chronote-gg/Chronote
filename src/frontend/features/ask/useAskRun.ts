import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { trpc } from "../../services/trpc";
import type { AskConversation, AskMessage } from "../../../types/ask";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../trpc/router";

type CompletedAsk = {
  conversationId: string;
  conversation: AskConversation;
  messages: AskMessage[];
};
type Send = {
  serverId: string;
  conversationId?: string;
  question: string;
  contextMeetingIds?: string[];
};
type Snapshot = inferRouterOutputs<AppRouter>["ask"]["startRun"];
type Scope = {
  userId: string | null;
  serverId: string | null;
  conversationId: string | null;
};
type Address = { serverId: string; conversationId: string; runId: string };
const storagePrefix = "chronote-ask-run:";

export function useAskRun(scope: Scope) {
  const utils = trpc.useUtils();
  const scopeKey = JSON.stringify([
    scope.userId,
    scope.serverId,
    scope.conversationId,
  ]);
  const [displayScope, setDisplayScope] = useState(scopeKey);
  const [isPending, setPending] = useState(false);
  const [text, setText] = useState("");
  const [question, setQuestion] = useState("");
  const [activity, setActivity] = useState<string>();
  const [recoveredResult, setRecoveredResult] = useState<CompletedAsk | null>(
    null,
  );
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const generation = useRef(0);
  const identity = useRef<{
    conversationId: string;
    requestId: string;
  } | null>(null);
  const active = useRef<Address | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const previousUser = useRef(scope.userId);
  const userPrefix = `${storagePrefix}${scope.userId ?? ""}:`;
  const serverPrefix = `${userPrefix}${scope.serverId ?? ""}:`;
  const newPointer = `${serverPrefix}new`;
  const save = (snapshot: {
    conversationId: string;
    requestId: string;
    runId?: string;
  }) => {
    if (!scope.userId) return;
    sessionStorage.setItem(
      `${serverPrefix}${snapshot.conversationId}`,
      JSON.stringify({ runId: snapshot.runId, requestId: snapshot.requestId }),
    );
    if (!scope.conversationId)
      sessionStorage.setItem(newPointer, snapshot.conversationId);
  };
  const forget = (conversationId: string) => {
    sessionStorage.removeItem(`${serverPrefix}${conversationId}`);
    if (sessionStorage.getItem(newPointer) === conversationId)
      sessionStorage.removeItem(newPointer);
  };
  const follow = (
    accepted: Snapshot,
    sendGeneration: number,
  ): Promise<CompletedAsk> => {
    const address = {
      serverId: scope.serverId ?? "",
      conversationId: accepted.conversationId,
      runId: accepted.runId,
    };
    active.current = address;
    setQuestion(accepted.question);
    setText(accepted.text);
    if (accepted.status === "completed" && accepted.result) {
      identity.current = null;
      forget(accepted.conversationId);
      return Promise.resolve(accepted.result);
    }
    return new Promise<CompletedAsk>((resolve, reject) => {
      let ended = false;
      let reconnecting = false;
      let reconnectStarted = 0;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        ended = true;
        clearTimeout(timer);
        subscription.unsubscribe();
        cancel.current = null;
      };
      const receive = (snapshot: Snapshot) => {
        if (ended || generation.current !== sendGeneration) return;
        setText(snapshot.text);
        setActivity(
          snapshot.activity ??
            (snapshot.status === "queued"
              ? "Waiting to start..."
              : "Working..."),
        );
        if (snapshot.status === "queued" || snapshot.status === "running")
          return;
        finish();
        identity.current = null;
        forget(snapshot.conversationId);
        if (snapshot.status === "completed" && snapshot.result)
          resolve(snapshot.result);
        else
          reject(
            new Error(
              snapshot.status === "stopped"
                ? "Stopped. You can send another question."
                : snapshot.status === "interrupted"
                  ? "This answer was interrupted. Send again to start a new run."
                  : "Unable to finish this answer. Try again.",
            ),
          );
      };
      const poll = async () => {
        if (ended) return;
        if (Date.now() - reconnectStarted > 120_000) {
          finish();
          reject(
            new Error(
              "The connection could not be restored. Reload to check the saved run.",
            ),
          );
          return;
        }
        try {
          receive(await utils.client.ask.getRun.query(address));
        } catch {
          setText("");
          setActivity("Connection lost. Reconnecting...");
        }
        if (!ended)
          timer = setTimeout(() => {
            void poll();
          }, 2000);
      };
      const reconnect = () => {
        if (ended || reconnecting) return;
        reconnecting = true;
        reconnectStarted = Date.now();
        void poll();
      };
      const subscription = utils.client.ask.watchRun.subscribe(address, {
        onData: receive,
        onError: reconnect,
        onComplete: reconnect,
      });
      cancel.current = () => {
        finish();
        reject(new DOMException("Scope changed", "AbortError"));
      };
      receive(accepted);
    });
  };
  useEffect(() => {
    generation.current += 1;
    setDisplayScope(scopeKey);
    const currentGeneration = generation.current;
    identity.current = null;
    active.current = null;
    setPending(false);
    setText("");
    setQuestion("");
    setActivity(undefined);
    setRecoveredResult(null);
    setRecoveryError(null);
    if (previousUser.current && previousUser.current !== scope.userId) {
      const prefix = `${storagePrefix}${previousUser.current}:`;
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
    previousUser.current = scope.userId;
    const conversationId =
      scope.conversationId ?? sessionStorage.getItem(newPointer);
    const saved =
      conversationId && scope.userId && scope.serverId
        ? sessionStorage.getItem(`${serverPrefix}${conversationId}`)
        : null;
    if (saved && conversationId) {
      const restore = async () => {
        setPending(true);
        setActivity("Reconnecting to saved answer...");
        try {
          const parsed = z
            .object({
              runId: z.string().min(1).max(128).optional(),
              requestId: z.string().min(1).max(128),
            })
            .parse(JSON.parse(saved));
          identity.current = { conversationId, requestId: parsed.requestId };
          const snapshot = parsed.runId
            ? await utils.client.ask.getRun.query({
                serverId: scope.serverId ?? "",
                conversationId,
                runId: parsed.runId,
              })
            : await utils.client.ask.getRunByRequest.query({
                serverId: scope.serverId ?? "",
                conversationId,
                requestId: parsed.requestId,
              });
          if (generation.current !== currentGeneration) return;
          if (!snapshot) {
            setRecoveryError(
              "The previous send is unconfirmed. Send the same question again to retry its saved request.",
            );
            return;
          }
          save(snapshot);
          const result = await follow(snapshot, currentGeneration);
          if (generation.current === currentGeneration)
            setRecoveredResult(result);
        } catch (error) {
          if (
            generation.current === currentGeneration &&
            !(error instanceof DOMException && error.name === "AbortError")
          )
            setRecoveryError(
              error instanceof Error
                ? error.message
                : "Unable to reconnect to the saved run.",
            );
        } finally {
          if (generation.current === currentGeneration) {
            setPending(false);
            active.current = null;
          }
        }
      };
      void restore();
    }
    return () => {
      generation.current += 1;
      cancel.current?.();
    };
  }, [scope.userId, scope.serverId, scope.conversationId]);

  const mutateAsync = async (input: Send): Promise<CompletedAsk> => {
    const sendGeneration = generation.current;
    if (!identity.current)
      identity.current = {
        conversationId: input.conversationId ?? crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      };
    const sendIdentity = identity.current;
    setPending(true);
    setText("");
    setQuestion(input.question);
    setActivity("Starting...");
    setRecoveryError(null);
    try {
      save(sendIdentity);
      const accepted = await utils.client.ask.startRun.mutate({
        ...input,
        conversationId: sendIdentity.conversationId,
        requestId: sendIdentity.requestId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (sendGeneration !== generation.current)
        throw new DOMException("Scope changed", "AbortError");
      save(accepted);
      return await follow(accepted, sendGeneration);
    } finally {
      if (sendGeneration === generation.current) {
        active.current = null;
        setPending(false);
      }
    }
  };
  const stop = async () => {
    if (!active.current) return;
    setActivity("Stopping...");
    await utils.client.ask.stopRun.mutate(active.current);
  };
  const reset = () => {
    generation.current += 1;
    cancel.current?.();
    sessionStorage.removeItem(newPointer);
    identity.current = null;
    active.current = null;
    setPending(false);
    setText("");
    setQuestion("");
    setActivity(undefined);
    setRecoveredResult(null);
    setRecoveryError(null);
  };
  const currentScope = displayScope === scopeKey;
  return {
    mutateAsync,
    reset,
    isPending: currentScope && isPending,
    text: currentScope ? text : "",
    question: currentScope ? question : "",
    activity: currentScope ? activity : undefined,
    stop,
    recoveredResult: currentScope ? recoveredResult : null,
    recoveryError: currentScope ? recoveryError : null,
  };
}
