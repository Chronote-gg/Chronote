/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
jest.mock("../../src/db", () => ({
  getMeetingUpdateDeliveryRepository: jest.fn(),
  getMeetingUpdateDeliveryIndexStatus: jest.fn(async () => "ACTIVE"),
}));
jest.mock("../../src/services/meetingUpdateDeliveryService", () => ({
  deliverMeetingUpdate: jest.fn(),
  reconcileMeetingUpdate: jest.fn(),
}));
beforeEach(() => jest.resetModules());

async function startup() {
  const worker =
    await import("../../src/services/meetingUpdateDeliveryWorkerService");
  const db = await import("../../src/db");
  const repository = createMockMeetingUpdateDeliveryRepository(
    new Map(),
    () => false,
  );
  jest
    .mocked(db.getMeetingUpdateDeliveryRepository)
    .mockReturnValue(repository);
  return { ...worker, db, repository };
}
test("a late serving callback cannot reopen a sealed worker", async () => {
  const worker = await startup();
  await worker.stopMeetingUpdateDeliveryWorker();
  worker.startMeetingUpdateDeliveryWorker();
  await Promise.resolve();
  expect(worker.db.getMeetingUpdateDeliveryRepository).not.toHaveBeenCalled();
});
test("preparation does not poll until the serving callback activates delivery", async () => {
  const worker = await startup();
  const list = jest.spyOn(worker.repository, "listDue");
  try {
    await worker.prepareMeetingUpdateDeliveryWorker();
    expect(list).not.toHaveBeenCalled();
    worker.startMeetingUpdateDeliveryWorker();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    await worker.stopMeetingUpdateDeliveryWorker();
  }
});
test("repository construction failure is owned by awaited preparation", async () => {
  const worker = await startup();
  jest
    .mocked(worker.db.getMeetingUpdateDeliveryRepository)
    .mockImplementation(() => {
      throw new Error("repository construction failed");
    });
  await expect(worker.prepareMeetingUpdateDeliveryWorker()).rejects.toThrow(
    "repository construction failed",
  );
  expect(() => worker.startMeetingUpdateDeliveryWorker()).toThrow(
    "not prepared",
  );
  await worker.stopMeetingUpdateDeliveryWorker();
});
test("shutdown seals pending preparation before it can construct or activate a worker", async () => {
  const worker = await startup();
  const preparation = worker.prepareMeetingUpdateDeliveryWorker();
  const shutdown = worker.stopMeetingUpdateDeliveryWorker();
  await Promise.all([preparation, shutdown]);
  worker.startMeetingUpdateDeliveryWorker();
  expect(worker.db.getMeetingUpdateDeliveryRepository).not.toHaveBeenCalled();
});
