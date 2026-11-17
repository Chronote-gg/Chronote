import { createHash, randomUUID } from "node:crypto";
import {
  getAskRunRepository,
  type AskRunRepository,
} from "../repositories/askRunRepository";
import {
  type AskRunInput,
  type AskRunRecord,
  type AskRunResult,
  type AskRunScope,
  type AskRunSnapshot,
  isAskRunActive,
} from "../types/askRun";

export type AskRunExecutionContext = AskRunInput & {
  signal: AbortSignal;
  privateState?: unknown;
  onTextDelta: (text: string) => void;
  onToolActivity: (activity: string) => void;
  assertOwnership: () => Promise<void>;
};
export type AskRunExecutionResult = {
  result: AskRunResult;
  privateState?: unknown;
};
export type AskRunServiceOptions = {
  execute: (context: AskRunExecutionContext) => Promise<AskRunExecutionResult>;
  onCompleted?: (scope: AskRunScope, run: AskRunSnapshot) => Promise<unknown>;
  repository?: AskRunRepository;
  leaseMs?: number;
  pollMs?: number;
  now?: () => number;
};
export const runIdentity = (input: AskRunScope & { requestId: string }) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.userId,
        input.guildId,
        input.conversationId,
        input.requestId,
      ]),
    )
    .digest("hex");
const snapshot = (record: AskRunRecord): AskRunSnapshot =>
  structuredClone(record.snapshot);

export function createAskRunService({
  execute,
  onCompleted,
  repository = getAskRunRepository(),
  leaseMs = 30_000,
  pollMs = 1000,
  now = Date.now,
}: AskRunServiceOptions) {
  const owners = new Map<
    string,
    { controller: AbortController; timer: ReturnType<typeof setInterval> }
  >();
  const iso = () => new Date(now()).toISOString();
  async function projectCompleted(record: AskRunRecord) {
    try {
      await onCompleted?.(record.input, snapshot(record));
    } catch {
      console.error(
        "Ask answer projection failed; the completed run remains available for retry.",
      );
    }
  }
  async function terminal(
    record: AskRunRecord,
    status: "stopped" | "interrupted",
    expired = false,
  ) {
    const next = {
      ...record,
      version: record.version + 1,
      snapshot: {
        ...record.snapshot,
        status,
        activity: undefined,
        updatedAt: iso(),
      },
    };
    if (await repository.replace(record, next, now(), expired)) return next;
    return repository.get(record.input, record.snapshot.runId);
  }
  async function load(scope: AskRunScope & { runId: string }) {
    const record = await repository.get(scope, scope.runId);
    if (!record) throw new Error("Ask run not found");
    if (
      isAskRunActive(record.snapshot.status) &&
      record.leaseExpiresAt <= now()
    ) {
      return (await terminal(record, "interrupted", true))!;
    }
    return record;
  }
  function launch(initial: AskRunRecord) {
    const controller = new AbortController();
    let record = initial;
    let pendingText = "";
    let activity: string | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const pending = queue.then(work);
      queue = pending.catch(() => undefined);
      return pending;
    };
    async function assertOwnership() {
      controller.signal.throwIfAborted();
      const current = await repository.get(record.input, record.snapshot.runId);
      if (
        !current ||
        current.ownerToken !== record.ownerToken ||
        !isAskRunActive(current.snapshot.status) ||
        current.leaseExpiresAt <= now()
      ) {
        controller.abort();
        throw new Error("Ask run ownership lost");
      }
      record = current;
    }
    async function save(
      status: AskRunSnapshot["status"],
      output?: AskRunExecutionResult,
    ) {
      await assertOwnership();
      const textToSave = pendingText;
      const next: AskRunRecord = {
        ...record,
        version: record.version + 1,
        leaseExpiresAt: now() + leaseMs,
        privateState: output?.privateState,
        snapshot: {
          ...record.snapshot,
          status,
          text: output
            ? output.result.answer
            : record.snapshot.text + textToSave,
          activity: isAskRunActive(status) ? activity : undefined,
          result: output?.result,
          updatedAt: iso(),
        },
      };
      if (!(await repository.replace(record, next, now()))) {
        controller.abort();
        throw new Error("Ask run ownership lost");
      }
      record = next;
      pendingText = pendingText.slice(textToSave.length);
    }
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void serialize(() => save("running"))
        .catch(() => controller.abort())
        .finally(() => {
          polling = false;
        });
    }, pollMs);
    timer.unref?.();
    owners.set(record.snapshot.runId, { controller, timer });
    void (async () => {
      try {
        await serialize(() => save("running"));
        const privateState = await repository.getPrivateState(record.input);
        controller.signal.throwIfAborted();
        const output = await execute({
          ...record.input,
          privateState,
          signal: controller.signal,
          onTextDelta(text) {
            if (!controller.signal.aborted) pendingText += text;
          },
          onToolActivity(value) {
            if (!controller.signal.aborted) activity = value;
          },
          assertOwnership: () => serialize(assertOwnership),
        });
        await serialize(() => save("completed", output));
        clearInterval(timer);
        await projectCompleted(record);
      } catch {
        // A lost owner cannot overwrite the canonical stop or interruption.
        if (!controller.signal.aborted)
          await serialize(() => save("failed")).catch(() => controller.abort());
      } finally {
        clearInterval(timer);
        owners.delete(record.snapshot.runId);
      }
    })();
  }
  return {
    async start(input: AskRunInput): Promise<AskRunSnapshot> {
      const runId = runIdentity(input);
      const existing = await repository.get(input, runId);
      if (existing) return snapshot(await load({ ...input, runId }));
      const active = await repository.getActive(input);
      if (active) {
        const current = await load({ ...input, runId: active.snapshot.runId });
        if (isAskRunActive(current.snapshot.status))
          throw new Error("Conversation already has an active Ask run");
      }
      const record: AskRunRecord = {
        input: structuredClone(input),
        ownerToken: randomUUID(),
        version: 0,
        leaseExpiresAt: now() + leaseMs,
        snapshot: {
          runId,
          requestId: input.requestId,
          conversationId: input.conversationId,
          question: input.question,
          status: "queued",
          text: "",
          createdAt: iso(),
          updatedAt: iso(),
        },
      };
      let accepted: boolean;
      try {
        accepted = await repository.create(record);
      } catch (error) {
        const saved = await repository.get(input, runId);
        if (saved) return snapshot(saved);
        throw error;
      }
      if (!accepted) {
        const saved = await repository.get(input, runId);
        if (saved) return snapshot(await load({ ...input, runId }));
        throw new Error("Conversation already has an active Ask run");
      }
      launch(record);
      return snapshot(record);
    },
    async get(scope: AskRunScope & { runId: string }) {
      return snapshot(await load(scope));
    },
    async stop(scope: AskRunScope & { runId: string }) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const record = await load(scope);
        if (!isAskRunActive(record.snapshot.status)) return snapshot(record);
        const stopped = await terminal(record, "stopped");
        if (stopped && !isAskRunActive(stopped.snapshot.status)) {
          owners.get(scope.runId)?.controller.abort();
          return snapshot(stopped);
        }
      }
      throw new Error("Ask run changed while stopping; retry Stop");
    },
    dispose() {
      for (const owner of owners.values()) {
        clearInterval(owner.timer);
        owner.controller.abort();
      }
      owners.clear();
    },
  };
}
