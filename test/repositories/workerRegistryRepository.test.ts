/** @jest-environment node */
import {
  createMockWorkerRegistryRepository,
  getWorkerRegistryRepository,
  type LegacyRow,
} from "../../src/repositories/workerRegistryRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { useMockModeStore } from "./mockModeStore.fixture";
import {
  workerRecord,
  workerRegistryContract,
} from "./workerRegistryRepository.contract";

describe("mock worker registry", () => {
  workerRegistryContract(async () => {
    const legacy = new Map<string, LegacyRow>();
    return {
      repository: createMockWorkerRegistryRepository(new Map(), legacy),
      async seedLegacy(row) {
        legacy.set(JSON.stringify([row.pk, row.sk]), row);
      },
    };
  });
});

describe("mock-mode binding", () => {
  useMockModeStore();

  it("shares one registry per mock store", async () => {
    await getWorkerRegistryRepository().put(workerRecord("synthetic-a"));
    await expect(getWorkerRegistryRepository().read()).resolves.toEqual({
      workers: [workerRecord("synthetic-a")],
      cutover: false,
    });
    resetMockStore();
    await expect(getWorkerRegistryRepository().read()).resolves.toEqual({
      workers: [],
      cutover: false,
    });
  });
});
