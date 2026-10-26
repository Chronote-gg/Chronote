import type { MeetingUpdateDeliveryRepository } from "../../src/repositories/meetingUpdateDeliveryRepository";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import { fixture, message } from "./meetingUpdatePlan.fixture";
import { context } from "../deployment/controlFixtures";
import { now, key } from "../types/meetingUpdateDelivery.fixture";
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import { discordEditorMessageSchema } from "../../src/services/discordMessageEditor";
import type { MeetingHistory } from "../../src/types/db";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export function deliveryFixture(before = "Old notes", after = "Edited notes") {
  const input = fixture(before, after);
  const histories = new Map<string, MeetingHistory[]>([
    [key.guildId, [input.history]],
  ]);
  const repository = createMockMeetingUpdateDeliveryRepository(
    histories,
    () => true,
  );
  const remote = new Map(
    input.messages.map((item) => [item.id, structuredClone(item)]),
  );
  const calls: { method: string; id: string }[] = [];
  const requests: { method: string; id: string; payload: unknown }[] = [];
  let intercept:
    ((method: string, id: string) => Promise<Response | undefined>) | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = String(url).split("/");
    const id = path.at(-1)!;
    const method = init?.method ?? "GET";
    if (id === "@me") return Response.json({ id: input.botId, bot: true });
    if (path.at(-2) === "channels") return Response.json(input.channels[0]);
    calls.push({ method, id });
    const response = await intercept?.(method, id);
    if (response) return response;
    if (method === "GET")
      return remote.has(id)
        ? Response.json(remote.get(id))
        : new Response(null, { status: 404 });
    return mutateRemote(method, id, init);
  };
  function mutateRemote(method: string, id: string, init?: RequestInit) {
    const payload: unknown = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    requests.push({ method, id, payload });
    if (method === "DELETE") {
      remote.delete(id);
      return new Response(null, { status: 204 });
    }
    const parsed = discordEditorMessageSchema.parse(
      method === "POST"
        ? message(String(900000 + requests.length), [])
        : remote.get(id),
    );
    const body =
      typeof payload === "object" && payload !== null && "embeds" in payload
        ? payload.embeds
        : [];
    const next = discordEditorMessageSchema.parse({ ...parsed, embeds: body });
    remote.set(next.id, next);
    return Response.json(next);
  }
  const read = async () => {
    const row = await repository.getStrong(key);
    if (!row?.updateDelivery) throw new Error("Expected durable delivery");
    return { ...row, updateDelivery: row.updateDelivery };
  };
  const save = async (notes = "Newer notes") => {
    const row = await read();
    const mutation = { kind: "notes", notes } satisfies Parameters<
      typeof requestMeetingUpdateDelivery
    >[0]["mutation"];
    const nextDelivery = requestMeetingUpdateDelivery({
      history: row,
      mutation,
      revision: crypto.randomUUID(),
      now,
      policy: { kind: "active" },
    });
    const result = await repository.updateContentAndDelivery({
      key,
      expectedContentRevision: row.contentRevision ?? 0,
      expectedDeliveryRevision: row.updateDelivery.revision,
      mutation,
      nextDelivery,
      mutationId: crypto.randomUUID(),
      at: now,
      notesEdit: {
        expectedNotesVersion: row.notesVersion ?? 1,
        editedBy: "synthetic-editor",
      },
    });
    expect(result.kind).toBe("committed");
  };
  return {
    input,
    repository,
    remote,
    requests,
    calls,
    fetchImpl,
    read,
    save,
    intercept: (run: typeof intercept) => {
      intercept = run;
    },
    setRow: (row: MeetingHistory) => histories.set(key.guildId, [row]),
    authority: { kind: "serving", context: { ...context, now } } as const,
  };
}
export function loseAcknowledgement(
  repository: MeetingUpdateDeliveryRepository,
  method: "transition" | "registerNotesPointers",
  when: (
    input: Parameters<MeetingUpdateDeliveryRepository["transition"]>[0],
  ) => boolean,
) {
  const original = repository.transition.bind(repository);
  if (method !== "transition") throw new Error("Use pointer boundary directly");
  jest.spyOn(repository, "transition").mockImplementation(async (input) => {
    const result = await original(input);
    if (when(input)) throw new Error("Synthetic acknowledgement loss");
    return result;
  });
}

type DeliveryTransition = Parameters<
  MeetingUpdateDeliveryRepository["transition"]
>[0];
export function hasSubmission(input: DeliveryTransition, kind: string) {
  return (
    input.change.kind === "progress" &&
    "operations" in input.change.progress &&
    input.change.progress.operations.some((op) => op.submission.kind === kind)
  );
}
export function afterTransition(
  repository: MeetingUpdateDeliveryRepository,
  when: (input: DeliveryTransition) => boolean,
  after: () => void | Promise<void>,
) {
  const original = repository.transition.bind(repository);
  jest.spyOn(repository, "transition").mockImplementation(async (input) => {
    const result = await original(input);
    if (when(input)) await after();
    return result;
  });
}
export function failStrongReads(repository: MeetingUpdateDeliveryRepository) {
  jest
    .spyOn(repository, "getStrong")
    .mockRejectedValue(new Error("Read unavailable"));
}
export function interceptRenewal(
  repository: MeetingUpdateDeliveryRepository,
  handle: (
    proceed: () => ReturnType<MeetingUpdateDeliveryRepository["transition"]>,
  ) => ReturnType<MeetingUpdateDeliveryRepository["transition"]>,
) {
  const original = repository.transition.bind(repository);
  jest.spyOn(repository, "transition").mockImplementation((input) => {
    const proceed = () => original(input);
    return input.change.kind === "progress" &&
      "claim" in input.change.progress &&
      input.change.progress.claim.leaseExpiresAt > now + 60
      ? handle(proceed)
      : proceed();
  });
}
export function holdPatch(f: ReturnType<typeof deliveryFixture>) {
  const entered = deferred<void>();
  const tail = deferred<Response>();
  f.intercept(async (method) => {
    if (method !== "PATCH") return undefined;
    entered.resolve();
    return tail.promise;
  });
  return { entered, tail };
}
