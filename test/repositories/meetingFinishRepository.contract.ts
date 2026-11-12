import type { FinisherRow } from "../../src/repositories/meetingFinishRepository";
import type { MeetingHistory } from "../../src/types/db";
import { captureEndContract } from "./meetingFinishRepository.captureEnd.contract";
import { claimContract } from "./meetingFinishRepository.claim.contract";
import {
  GUILD,
  NOW,
  collect,
  finisherRow,
  historyRow,
  keyOf,
  type MeetingFinishHarness,
} from "./meetingFinishRepository.contract.fixture";
import { heldClaimContract } from "./meetingFinishRepository.heldClaim.contract";

export {
  historyRow,
  type MeetingFinishHarness,
} from "./meetingFinishRepository.contract.fixture";

export function meetingFinishContract(
  make: () => Promise<MeetingFinishHarness>,
) {
  let current: MeetingFinishHarness | undefined;
  beforeEach(async () => {
    current = await make();
  });
  afterEach(async () => {
    await current?.dispose?.();
  });

  const active = () => {
    if (!current) throw new Error("the harness is made before each test");
    return current;
  };
  // Each part of the contract reads the harness of the test that is running.
  const h: MeetingFinishHarness = {
    get repository() {
      return active().repository;
    },
    seedHistory: (row) => active().seedHistory(row),
    seedLease: (lease) => active().seedLease(lease),
    readHistory: (key) => active().readHistory(key),
  };

  async function seed(id: string, overrides: Partial<MeetingHistory> = {}) {
    const row = historyRow(id, overrides);
    await h.seedHistory(row);
    return row;
  }

  captureEndContract({ h, seed });
  claimContract({ h, seed });

  describe("read", () => {
    it("returns the whole row, or undefined when there is none", async () => {
      const row = await seed("a", { notes: "synthetic notes" });
      await expect(h.repository.read(keyOf(row))).resolves.toEqual(row);
      await expect(
        h.repository.read({ guildId: GUILD, channelId_timestamp: "missing" }),
      ).resolves.toBeUndefined();
    });
  });

  heldClaimContract({ h, seed });

  describe("abandon", () => {
    it("abandon is idempotent", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: { attempts: 1, phase: "process" },
      });
      await expect(h.repository.abandon(finisherRow(row), NOW)).resolves.toBe(
        true,
      );
      const failed = await h.readHistory(keyOf(row));
      expect(failed?.status).toBe("failed");
      expect(failed).not.toHaveProperty("finish");
      await expect(
        h.repository.abandon(finisherRow(row), NOW + 1),
      ).resolves.toBe(false);
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(failed);
    });

    it("abandon records a failure before notes when no processing outcome exists", async () => {
      const row = await seed("a", { status: "in_progress" });
      await h.repository.abandon(finisherRow(row), NOW);
      expect((await h.readHistory(keyOf(row)))?.processing).toEqual({
        transcription: "failed",
        notes: "skipped",
        summary: "skipped",
      });
      const recorded = await seed("b", {
        status: "processing",
        processing: { transcription: "ready" },
      });
      await h.repository.abandon(finisherRow(recorded), NOW);
      expect((await h.readHistory(keyOf(recorded)))?.processing).toEqual({
        transcription: "ready",
      });
    });

    it("abandon refuses a row without the lifecycle marker", async () => {
      const row = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      await expect(h.repository.abandon(finisherRow(row), NOW)).resolves.toBe(
        false,
      );
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it("leaves a terminal row alone", async () => {
      const row = await seed("a", { status: "complete" });
      await expect(h.repository.abandon(finisherRow(row), NOW)).resolves.toBe(
        false,
      );
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });
  });

  describe("scan", () => {
    it("scan returns only marked open rows", async () => {
      const open = [
        await seed("starting", { status: "starting" }),
        await seed("live"),
        await seed("processing", { status: "processing" }),
        await seed("delivering", {
          status: "complete",
          finish: { attempts: 1, phase: "deliver", deliverSince: NOW },
        }),
      ];
      await seed("complete", { status: "complete" });
      await seed("failed", { status: "failed" });
      await seed("legacy", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      await seed("legacy-finish", {
        status: "complete",
        lifecycleVersion: undefined,
        finish: { attempts: 0, phase: "deliver" },
      });
      const rows = await collect(
        h.repository.scan(new AbortController().signal),
      );
      const byKey = (a: FinisherRow, b: FinisherRow) =>
        a.channelId_timestamp.localeCompare(b.channelId_timestamp);
      expect(rows.sort(byKey)).toEqual(open.map(finisherRow).sort(byKey));
    });

    it("projects only the finisher fields", async () => {
      await seed("a", { notes: "synthetic notes", status: "processing" });
      const [row] = await collect(
        h.repository.scan(new AbortController().signal),
      );
      expect(row).not.toHaveProperty("notes");
      expect(row).not.toHaveProperty("participants");
    });

    it("yields nothing once the signal has aborted", async () => {
      await seed("a");
      const controller = new AbortController();
      controller.abort();
      await expect(
        collect(h.repository.scan(controller.signal)),
      ).resolves.toEqual([]);
    });
  });

  describe("listStranded", () => {
    it("lists non-terminal rows without the marker", async () => {
      const stranded = [
        await seed("starting", {
          status: "starting",
          lifecycleVersion: undefined,
        }),
        await seed("processing", {
          status: "processing",
          lifecycleVersion: undefined,
        }),
      ];
      await seed("complete", {
        status: "complete",
        lifecycleVersion: undefined,
      });
      await seed("interrupted", {
        status: "interrupted",
        lifecycleVersion: undefined,
      });
      await seed("marked", { status: "processing" });
      const rows = await collect(
        h.repository.listStranded(new AbortController().signal),
      );
      const byKey = (a: MeetingHistory, b: MeetingHistory) =>
        a.channelId_timestamp.localeCompare(b.channelId_timestamp);
      expect(rows.sort(byKey)).toEqual(stranded.sort(byKey));
    });
  });
}
