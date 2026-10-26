/** @jest-environment node */
import "../services/meetingUpdateDeliveryRuntime";
import { isDeepStrictEqual } from "node:util";
import { publicationWorker } from "./meetingPublicationWorker.fixture";
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { publicationHttpFixture } from "./meetingPublicationHttp.fixture";
import { publicationStorageFixture } from "../services/recoveryDiscordPublicationStorage.fixture";
import {
  fixture,
  input as scope,
} from "../services/recoveryDiscordPublication.fixture";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";
import { pending } from "../types/meetingUpdateDelivery.fixture";

import { createDiscordMessageEditor } from "../../src/services/discordMessageEditor";

import { createRecoveryPublicationBarrier } from "../../src/services/recoveryDiscordPublicationBarrier";
import {
  applyRecoveryDiscordPublication,
  previewRecoveryDiscordPublication,
  type PublicationDependencies,
} from "../../src/services/recoveryDiscordPublication";
import {
  bindRecoveryPublication,
  publicationHistorySchema,
  recoveryPublicationManifestSchema,
} from "../../src/services/recoveryDiscordPublicationTypes";

test.each(["repair-first", "worker-first"] as const)(
  "real repair and worker share row exclusion before held HTTP: %s",
  async (order) => {
    const { f, http, worker, deps, preview } = await repairWorkerFixture();
    const held = http.holdPatch();
    try {
      if (order === "repair-first") {
        const repair = applyRecoveryDiscordPublication(preview, deps);
        await held.entered.promise;
        expect((await f.read())?.publicationRepair?.kind).toBe("running");
        await worker.poll();
        expect(http.writes).toHaveLength(1);
        held.tail.release();
        expect((await repair).status).toBe("verified");
        expect((await f.read())?.publicationRepair?.kind).toBe("settled");
      } else {
        const polling = worker.poll();
        await held.entered.promise;
        await expect(
          applyRecoveryDiscordPublication(preview, deps),
        ).rejects.toThrow("occupied");
        expect(http.writes).toHaveLength(1);
        expect((await f.read())?.publicationRepair).toBeUndefined();
        held.tail.release();
        await polling;
      }
      expect(http.writes.map(({ method }) => method)).toEqual(["PATCH"]);
    } finally {
      held.tail.release();
      await closeRepairFixture({ f, http, worker });
    }
  },
);

async function repairWorkerFixture(enrolled = true) {
  const input = fixture();
  const key = {
    guildId: scope.guildId,
    channelId_timestamp: scope.meetingKey,
  };
  const f = await publicationDynamoFixture(key);
  let http: Awaited<ReturnType<typeof publicationHttpFixture>> | undefined;
  let worker: ReturnType<typeof publicationWorker> | undefined;
  try {
    await f.put(
      f.tables.meetingHistory,
      enrolled
        ? {
            ...input.history,
            contentRevision: 1,
            updateDelivery: pending(),
            updateDeliveryQueue: "meeting-update:v1",
            updateDeliveryDueAt: 0,
          }
        : input.history,
    );
    await f.admit();
    http = await publicationHttpFixture({
      botId: "500",
      guildId: scope.guildId,
      channelId: "300",
      messages: [...input.messages.values()],
    });
    const editor = createDiscordMessageEditor({
      token: "synthetic",
      fetchImpl: http.fetchImpl,
    });

    worker = publicationWorker({
      repository: f.updates,
      fetchImpl: http.fetchImpl,
    });
    const storage = publicationStorageFixture();
    const deps: PublicationDependencies = {
      ...input.deps,
      storage: storage.storage,
      readHistory: async () => f.read(),
      discord: editor,
      publication: createRecoveryPublicationBarrier({
        repository: f.publication,
        key,
        validate: async (row, binding) =>
          isDeepStrictEqual(
            bindRecoveryPublication(
              scope,
              publicationHistorySchema.parse(row),
              recoveryPublicationManifestSchema.parse(input.manifest),
            ),
            binding,
          ),
      }),
    };
    const preview = await previewRecoveryDiscordPublication(scope, deps);
    expect(preview.kind).toBe("ready");

    return { f, http, worker, deps, preview, key };
  } catch (error) {
    await closeRepairFixture({ f, http, worker });
    throw error;
  }
}
async function closeRepairFixture(input: {
  f: Awaited<ReturnType<typeof publicationDynamoFixture>>;
  http?: Awaited<ReturnType<typeof publicationHttpFixture>>;
  worker?: ReturnType<typeof publicationWorker>;
}) {
  try {
    await input.worker?.stop();
  } finally {
    try {
      await input.http?.close();
    } finally {
      await input.f.close();
    }
  }
}
test("verified legacy repair before enrollment permits subsequent ordinary action and worker delivery", async () => {
  const { f, http, worker, deps, preview, key } =
    await repairWorkerFixture(false);
  try {
    const receipt = await applyRecoveryDiscordPublication(preview, deps);
    expect(receipt.status).toBe("verified");
    const repaired = await f.read();
    expect(repaired?.publicationRepair).toMatchObject({
      kind: "settled",
      runId: receipt.runId,
      previewDigest: preview.previewDigest,
    });
    expect(repaired?.updateDelivery?.policy).toEqual({ kind: "active" });
    expect(repaired?.updateDelivery?.lastSuccess).toBeNull();
    const action = createMeetingUpdateService({
      repository: f.updates,
      ready: async () => {},
      syncNotes: jest.fn(async () => {}),
    });
    expect(
      (
        await action({
          key,
          actor: { editedBy: "synthetic-editor" },
          mutation: {
            kind: "notes",
            notes: "New ordinary canonical notes",
            notesDelta: null,
          },
          notesEdit: {
            expectedNotesVersion: repaired?.notesVersion ?? 1,
            source: { type: "web_editor" },
          },
        })
      ).kind,
    ).toBe("saved");
    expect((await f.read())?.updateDelivery?.policy).toEqual({
      kind: "active",
    });
    await worker.poll();
    let delivered = await f.read();
    for (
      let remaining = 200;
      remaining > 0 &&
      delivered?.updateDelivery?.lastSuccess?.contentRevision !== 1;
      remaining--
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      delivered = await f.read();
    }
    expect(projectMeetingUpdateDelivery(delivered!)).toMatchObject({
      status: "synced",
      syncedRevision: 1,
      lastSuccess: { contentRevision: 1 },
    });
    expect(http.writes.length).toBeGreaterThan(1);
  } finally {
    await closeRepairFixture({ f, http, worker });
  }
});
