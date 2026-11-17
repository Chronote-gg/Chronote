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
import { operationSignal } from "./shutdownSignal";

const POLL_INTERVAL_MS = 5000;
const CANDIDATE_LIMIT = 25;
/** How long one poll may keep discovering and starting deliveries. */
const POLL_BUDGET_SECONDS = 10;
const CONCURRENT_MEETINGS = 2;
type Dependencies = {
  repository: Pick<MeetingUpdateDeliveryRepository, "getStrong" | "listDue">;
  deliver(input: MeetingDeliveryRunInput): Promise<MeetingDeliveryRunResult>;
  reconcile(input: MeetingDeliveryRunInput): Promise<MeetingDeliveryRunResult>;
  now(): number;
  isEligible(): boolean;
};
export function createMeetingUpdateDeliveryWorker(deps: Dependencies) {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let page: MeetingDuePage | undefined;
  let offset = 0;
  let cursor: string | undefined;
  const controller = new AbortController();
  const signal = operationSignal(controller.signal);
  const handlers = new Map<string, Promise<void>>();
  /** The delivery's claim write is the only cross-worker gate; this map only keeps one local run per meeting. */
  function process(key: MeetingUpdateKey, reconcile: boolean) {
    const id = `meeting-update:${JSON.stringify(key)}`;
    if (stopped || handlers.has(id)) return;
    const actual = (reconcile ? deps.reconcile : deps.deliver)({ key, signal })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        handlers.delete(id);
      });
    handlers.set(id, actual);
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
      await Promise.race([wait, ...handlers.values()]);
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
  async function loadPage(limit: number) {
    page = await deps.repository.listDue({
      now: Math.floor(deps.now()),
      limit,
      cursor,
      signal,
    });
    offset = 0;
    return page;
  }
  async function visit(key: MeetingUpdateKey, deadline: number) {
    const row = await deps.repository.getStrong(key, signal);
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
  function hasPollBudget(visited: number, deadline: number) {
    return !stopped && visited < CANDIDATE_LIMIT && deps.now() < deadline;
  }
  async function runPoll() {
    const deadline = deps.now() + POLL_BUDGET_SECONDS;
    let visited = 0,
      pages = 0;
    while (hasPollBudget(visited, deadline)) {
      await capacity(deadline);
      if (budgetExhausted(deadline)) return;
      if (!page && ++pages > CANDIDATE_LIMIT) return;
      const current = page ?? (await loadPage(CANDIDATE_LIMIT - visited));
      if (budgetExhausted(deadline)) return;
      if (offset >= current.keys.length) {
        finishPage();
        if (!cursor) return;
        continue;
      }
      visited++;
      if (!(await visit(current.keys[offset++], deadline))) return;
    }
    finishPage();
  }
  function poll(): Promise<void> {
    if (stopped || !deps.isEligible()) return Promise.resolve();
    if (pending) return pending;
    // A failed read ends this poll; the next one starts over from the cursor it left.
    pending = runPoll()
      .catch(() => {})
      .finally(() => {
        pending = undefined;
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
      return Promise.all([pending, ...handlers.values()]).then(() => undefined);
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
export async function prepareMeetingUpdateDeliveryWorker(): Promise<void> {
  if (sealed || worker) return;
  if (starting) return starting;
  starting = Promise.all([
    import("../db"),
    import("./meetingUpdateDeliveryService"),
    import("./workerRegistry"),
  ])
    .then(([db, service, registry]) => {
      if (sealed) return;
      worker = createMeetingUpdateDeliveryWorker({
        repository: db.getMeetingUpdateDeliveryRepository(),
        deliver: service.deliverMeetingUpdate,
        reconcile: service.reconcileMeetingUpdate,
        now: () => Date.now() / 1000,
        isEligible: registry.isEligible,
      });
    })
    .finally(() => {
      starting = undefined;
    });
  return starting;
}
export function startMeetingUpdateDeliveryWorker(): void {
  if (sealed) return;
  if (!worker)
    throw new Error("Meeting update delivery worker is not prepared");
  worker.start();
}
export async function stopMeetingUpdateDeliveryWorker(): Promise<void> {
  sealed = true;
  await starting;
  await worker?.stop();
}
