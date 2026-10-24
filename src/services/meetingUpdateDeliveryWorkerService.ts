import { randomUUID } from "node:crypto";
import type {
  MeetingUpdateDeliveryRepository,
  MeetingDuePage,
} from "../repositories/meetingUpdateDeliveryRepository";
import {
  meetingUpdateDeliveryNextCheck,
  type MeetingUpdateKey,
} from "../types/meetingUpdateDelivery";
import type {
  MeetingDeliveryRunInput,
  MeetingDeliveryRunResult,
} from "./meetingUpdateDeliveryTypes";
import {
  beginRuntimeWorkClaim,
  type RuntimeWorkClaim,
} from "./runtimeWorkAdmissionService";

const POLL_INTERVAL_MS = 5000;
const CANDIDATE_LIMIT = 25;
const ADMISSION_SECONDS = 10;
const CONCURRENT_MEETINGS = 2;
type Dependencies = {
  repository: Pick<MeetingUpdateDeliveryRepository, "getStrong" | "listDue">;
  begin: typeof beginRuntimeWorkClaim;
  deliver(input: MeetingDeliveryRunInput): Promise<MeetingDeliveryRunResult>;
  reconcile(input: MeetingDeliveryRunInput): Promise<MeetingDeliveryRunResult>;
  now(): number;
};
type Handler = { work: RuntimeWorkClaim; actual: Promise<void> };
async function settleDeliveryWork(
  work: RuntimeWorkClaim,
  result?: Pick<MeetingDeliveryRunResult, "durable" | "noClaim">,
) {
  if (!result?.durable && !result?.noClaim) work.fence();
  await work.settle();
  if (!work.acknowledgeMeetingUpdateDelivery(result ?? {})) work.fence();
}
export function createMeetingUpdateDeliveryWorker(deps: Dependencies) {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let pollWork: RuntimeWorkClaim | undefined;
  let page: MeetingDuePage | undefined;
  let offset = 0;
  let cursor: string | undefined;
  const controller = new AbortController();
  const handlers = new Map<string, Handler>();
  function process(key: MeetingUpdateKey, reconcile: boolean) {
    const id = `meeting-update:${JSON.stringify(key)}`;
    if (stopped || handlers.has(id)) return;
    let work: RuntimeWorkClaim;
    try {
      work = deps.begin("meeting_update_delivery", id);
    } catch {
      return;
    }
    const actual = work.trackPromise(() =>
      (reconcile ? deps.reconcile : deps.deliver)({
        key,
        work,
        signal: controller.signal,
      }),
    );
    const complete = actual
      .then(
        (result) => settleDeliveryWork(work, result),
        () => settleDeliveryWork(work),
      )
      .finally(() => {
        handlers.delete(id);
      });
    handlers.set(id, { work, actual: complete });
  }
  async function capacity(deadline: number) {
    if (handlers.size < CONCURRENT_MEETINGS) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake!: () => void;
    const wait = new Promise<void>((resolve) => {
      wake = () => resolve();
      timer = setTimeout(resolve, Math.max(0, (deadline - deps.now()) * 1000));
      controller.signal.addEventListener("abort", wake, { once: true });
    });
    try {
      await Promise.race([
        wait,
        ...[...handlers.values()].map((h) => h.actual),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", wake);
    }
  }
  function budgetExhausted(deadline: number) {
    return (
      stopped || deps.now() >= deadline || handlers.size >= CONCURRENT_MEETINGS
    );
  }
  function finishPage() {
    if (page && offset >= page.keys.length) {
      cursor = page.cursor;
      page = undefined;
    }
  }
  async function loadPage(work: RuntimeWorkClaim, limit: number) {
    page = await work.trackEffect(() =>
      deps.repository.listDue({
        now: Math.floor(deps.now()),
        limit,
        cursor,
        signal: work.signal,
      }),
    );
    offset = 0;
    return page;
  }
  async function visit(
    work: RuntimeWorkClaim,
    key: MeetingUpdateKey,
    deadline: number,
  ) {
    const row = await work.trackEffect(() =>
      deps.repository.getStrong(key, work.signal),
    );
    if (stopped || deps.now() >= deadline) {
      offset--;
      return false;
    }
    if (!row?.updateDelivery) return true;
    const due = meetingUpdateDeliveryNextCheck(row.updateDelivery);
    if (due !== undefined && due <= deps.now())
      process(key, "attempt" in row.updateDelivery.progress);
    return true;
  }
  async function refreshPollAdmission(
    work: RuntimeWorkClaim,
    deadline: number,
  ) {
    if (budgetExhausted(deadline)) return false;
    await work.authority();
    return !budgetExhausted(deadline);
  }
  function hasAdmissionBudget(visited: number, deadline: number) {
    return !stopped && visited < CANDIDATE_LIMIT && deps.now() < deadline;
  }
  async function runPoll(work: RuntimeWorkClaim) {
    const deadline = deps.now() + ADMISSION_SECONDS;
    let visited = 0,
      pages = 0;
    while (hasAdmissionBudget(visited, deadline)) {
      await capacity(deadline);
      if (!(await refreshPollAdmission(work, deadline))) return;
      if (!page && ++pages > CANDIDATE_LIMIT) return;
      const current = page ?? (await loadPage(work, CANDIDATE_LIMIT - visited));
      if (budgetExhausted(deadline)) return;
      if (offset >= current.keys.length) {
        finishPage();
        if (!cursor) return;
        continue;
      }
      visited++;
      if (!(await visit(work, current.keys[offset++], deadline))) return;
    }
    finishPage();
  }
  function poll(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    let work: RuntimeWorkClaim;
    try {
      work = deps.begin(
        "meeting_update_delivery",
        `meeting-update:poll:${randomUUID()}`,
      );
    } catch {
      return Promise.resolve();
    }
    pollWork = work;
    const actual = work.trackPromise(() => runPoll(work));
    pending = actual
      .catch(() => work.fence())
      .then(() =>
        settleDeliveryWork(work, { noClaim: { kind: "never_admitted" } }),
      )
      .finally(() => {
        pending = undefined;
        pollWork = undefined;
      });
    return pending;
  }
  return {
    poll,
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => {
        void poll();
      }, POLL_INTERVAL_MS);
      timer.unref();
      void poll();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      controller.abort();
      pollWork?.fence();
      for (const handler of handlers.values()) handler.work.fence();
      return Promise.all([
        pending,
        ...[...handlers.values()].map((h) => h.actual),
      ]).then(() => undefined);
    },
  };
}
let worker: ReturnType<typeof createMeetingUpdateDeliveryWorker> | undefined;
let starting: Promise<void> | undefined;
let sealed = false;
export async function verifyMeetingUpdateDeliveryReadiness(
  status?: () => Promise<string | undefined>,
): Promise<void> {
  const read =
    status ?? (await import("../db")).getMeetingUpdateDeliveryIndexStatus;
  if ((await read()) !== "ACTIVE")
    throw new Error(
      "Meeting update delivery requires an ACTIVE UpdateDeliveryDueIndex",
    );
}
export function startMeetingUpdateDeliveryWorker(): void {
  if (sealed || starting || worker) return;
  starting = Promise.all([
    import("../db"),
    import("./meetingUpdateDeliveryService"),
  ])
    .then(([db, service]) => {
      if (sealed) return;
      worker = createMeetingUpdateDeliveryWorker({
        repository: db.getMeetingUpdateDeliveryRepository(),
        begin: beginRuntimeWorkClaim,
        deliver: service.deliverMeetingUpdate,
        reconcile: service.reconcileMeetingUpdate,
        now: () => Date.now() / 1000,
      });
      worker.start();
    })
    .finally(() => {
      starting = undefined;
    });
}
export async function stopMeetingUpdateDeliveryWorker(): Promise<void> {
  sealed = true;
  await starting;
  await worker?.stop();
}
