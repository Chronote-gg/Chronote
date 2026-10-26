/** @jest-environment node */
import { createPreservationBudget } from "../../src/services/preservationBudget";

afterEach(() => jest.useRealTimers());
test("oneDeadlineAcrossConcurrentMeetings", async () => {
  jest.useFakeTimers();
  const budget = createPreservationBudget(Date.now() + 100_000);
  const outcomes = [
    budget.wait(new Promise(() => {})),
    budget.wait(new Promise(() => {})),
  ];
  await jest.advanceTimersByTimeAsync(100_000);
  expect(await Promise.all(outcomes)).toEqual([
    { kind: "unresolved" },
    { kind: "unresolved" },
  ]);
  expect(budget.signal.aborted).toBe(true);
  budget.dispose();
});
test("an overlapping shutdown shortens existing preservation without renewing grace", async () => {
  jest.useFakeTimers();
  const budget = createPreservationBudget(Date.now() + 100_000);
  const pending = budget.wait(new Promise(() => {}));
  budget.shorten(Date.now() + 10_000);
  budget.shorten(Date.now() + 200_000);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await pending).toEqual({ kind: "unresolved" });
  expect(budget.signal.aborted).toBe(true);
  budget.dispose();
});
test("completion after expiry never becomes observed settlement", async () => {
  jest.useFakeTimers();
  let finish!: () => void;
  const effect = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const budget = createPreservationBudget(Date.now() + 100);
  const pending = budget.wait(effect);
  await jest.advanceTimersByTimeAsync(100);
  finish();
  expect(await pending).toEqual({ kind: "unresolved" });
  budget.dispose();
});

test("clock rollback and a smaller absolute deadline cannot extend elapsed grace", async () => {
  jest.useFakeTimers({ now: 4_000_000 });
  const budget = createPreservationBudget(Date.now() + 100_000);
  await jest.advanceTimersByTimeAsync(30_000);
  jest.setSystemTime(Date.now() - 3_600_000);
  budget.shorten(budget.deadline - 1);
  await jest.advanceTimersByTimeAsync(69_999);
  expect(budget.signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(budget.signal.aborted).toBe(true);
  budget.dispose();
});

test("clock forward jump tightens immediately instead of granting new elapsed grace", async () => {
  jest.useFakeTimers({ now: 4_000_000 });
  const budget = createPreservationBudget(Date.now() + 100_000);
  await jest.advanceTimersByTimeAsync(30_000);
  jest.setSystemTime(Date.now() + 3_600_000);
  budget.shorten(budget.deadline - 1);
  expect(budget.signal.aborted).toBe(true);
  budget.dispose();
});
