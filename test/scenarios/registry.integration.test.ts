/** @jest-environment node */
import {
  createRegistryTable,
  describeLocalDynamo,
  localDynamoClient,
} from "../repositories/workerRegistryDynamo.fixture";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { createWorkerRegistry } from "../../src/services/workerRegistry";

const MS_PER_SECOND = 1000;
const START_SECONDS = 1_000_000;

describeLocalDynamo(
  "scenario 14: first deployment beside the old protocol",
  () => {
    const client = localDynamoClient();
    afterAll(() => client.destroy());

    test("standby while the old runtime is fresh, then a permanent cutover", async () => {
      const table = await createRegistryTable(client);
      let nowMs = START_SECONDS * MS_PER_SECOND;
      const seconds = () => Math.floor(nowMs / MS_PER_SECOND);
      let pending: (() => Promise<void>) | undefined;
      const oldRuntime = (heartbeatAt: number) =>
        table.seedLegacy({
          pk: "ENV",
          sk: "RUNTIME#synthetic-old",
          heartbeatAt,
        });
      const registry = createWorkerRegistry({
        repository: table.repository,
        resolveIdentity: async () => ({
          instanceId: "synthetic-new",
          release: 1,
        }),
        nowMs: () => nowMs,
        schedule(run) {
          pending = run;
          return () => {
            pending = undefined;
          };
        },
        isShuttingDown: () => false,
      });
      async function heartbeat(advanceMs: number) {
        nowMs += advanceMs;
        const run = pending;
        if (!run) throw new Error("No heartbeat is scheduled");
        await run();
      }
      try {
        await oldRuntime(seconds());
        await registry.start({
          mode: "all",
          isGatewayReady: () => true,
          isServerListening: () => true,
          load: () => ({ captures: 0, finishing: 0 }),
        });
        expect(registry.hasBeenReady()).toBe(true);
        expect(registry.isEligible()).toBe(false);

        await heartbeat(
          LIFECYCLE.legacyHeartbeatStaleSeconds * MS_PER_SECOND - 1,
        );
        expect(registry.isEligible()).toBe(false);
        await expect(table.repository.read()).resolves.toMatchObject({
          cutover: false,
        });

        await heartbeat(1);
        expect(registry.isEligible()).toBe(true);
        await expect(table.repository.read()).resolves.toMatchObject({
          cutover: true,
        });

        await oldRuntime(seconds());
        await heartbeat(LIFECYCLE.registryHeartbeatMs);
        expect(registry.isEligible()).toBe(true);
        await registry.stop();
      } finally {
        await table.dispose();
      }
    });
  },
);
