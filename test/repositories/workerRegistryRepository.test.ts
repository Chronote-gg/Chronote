/** @jest-environment node */
import {
  createMockWorkerRegistryRepository,
  getWorkerRegistryRepository,
  type LegacyRow,
} from "../../src/repositories/workerRegistryRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
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
  const enabled = config.mock.enabled;
  beforeEach(() => {
    config.mock.enabled = true;
    resetMockStore();
  });
  afterEach(() => {
    config.mock.enabled = enabled;
    resetMockStore();
  });

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
