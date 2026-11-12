/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { qualifiedFixture } from "./fixtures/sourceLossPublicationFixture";
import { putIntroductionDocument } from "./fixtures/introductionStore";
import { bindingHash } from "../../scripts/deployment/continue-sandbox.cjs";
test("reviewed core restores the stranded candidate through real admission, receipt and routing seams", async () => {
  const f = await qualifiedFixture();
  try {
    const original = {
      runtime: await f.read("RUNTIME#old"),
      lease: await f.readLease(),
      voice: await f.readVoice(),
    };
    expect(f.lifecycle.isAcceptingWork()).toBe(false);
    expect(() => f.lifecycle.beginRuntimeWork("pending_admission")).toThrow();
    await expect(f.normal.promote()).rejects.toMatchObject({
      category: "native_protection_unconfirmed",
    });
    expect((await f.read("RUNTIME#new")).role).toBe("candidate");
    await f.inspect();
    await expect(f.apply()).resolves.toMatchObject({
      kind: "availability_restored",
      settlement: "lost_owner_settlement_pending",
    });
    expect(f.lifecycle.isAcceptingWork()).toBe(true);
    const registration = f.lifecycle.beginRuntimeWork("pending_admission");
    registration.settle();
    expect((await f.read("CONTROL")).servingMembers).toEqual({
      new: f.candidateIdentity,
    });
    expect((await f.read("RUNTIME#new")).authorizedGeneration).toBe(2);
    expect(await f.read("RUNTIME#old")).toEqual(original.runtime);
    expect(await f.readLease()).toEqual(original.lease);
    expect(await f.readVoice()).toEqual(original.voice);
    expect(await f.readReceipt()).toMatchObject({
      stage: "availability_restored",
      settlement: "lost_owner_settlement_pending",
    });
    expect(f.counts).toMatchObject({ admissionWrites: 1, listenerWrites: 1 });
  } finally {
    await f.stop();
  }
});

test.each(["unqualified", "same run", "compatible with pins"])(
  "preserves allowed publication path: %s",
  async (scenario) => {
    const compatible = scenario === "compatible with pins";
    const f = await qualifiedFixture({
      publicationControl: {
        publicationProtocol: 1,
        ...(compatible
          ? {
              publicationPins: {
                synthetic: {
                  authorities: ["synthetic-authority"],
                  settled: [],
                },
              },
            }
          : {}),
      },
      knownCompatible: compatible,
      sameRun: scenario === "same run",
    });
    try {
      const inspected = await f.inspect();
      expect(inspected.binding.publication.compatible).toBe(compatible);
      await expect(f.apply()).resolves.toMatchObject({
        kind: "availability_restored",
      });
      const ctl = await f.read("CONTROL");
      if (compatible) {
        expect(ctl.publicationTransition).toBeUndefined();
        expect(Object.keys(ctl.publicationPins)).toEqual(["synthetic"]);
      } else
        expect(ctl.publicationTransition).toMatchObject({
          runToken: f.packet.operation.deployment.runToken,
        });
      expect(f.counts).toMatchObject({
        admissionWrites: 1,
        listenerWrites: 1,
        otherWrites: 0,
      });
    } finally {
      await f.stop();
    }
  },
);

test.each(["unresolved pins", "other transition", "wrong same-run images"])(
  "inspection refuses %s for unqualified images",
  async (scenario) => {
    const f = await qualifiedFixture({
      publicationControl: { publicationProtocol: 1 },
    });
    try {
      const ctl = await f.read("CONTROL");
      if (scenario === "unresolved pins")
        ctl.publicationPins = {
          synthetic: { authorities: ["synthetic-authority"], settled: [] },
        };
      else
        ctl.publicationTransition = {
          runToken:
            scenario === "other transition" ? "other" : ctl.deployment.runToken,
          images: [],
        };
      await putIntroductionDocument(f.table, ctl);
      await expect(f.inspect()).rejects.toThrow();
      expect(f.counts).toMatchObject({
        admissionWrites: 0,
        listenerWrites: 0,
        otherWrites: 0,
      });
    } finally {
      await f.stop();
    }
  },
);

test("changed release evidence invalidates the approved binding", async () => {
  const f = await qualifiedFixture();
  try {
    await f.inspect();
    f.options.publicationReleases = {
      contract: "first_publication_archive_fence_v1",
      images: ["sha256:" + "f".repeat(64)],
    };
    await expect(f.apply()).rejects.toThrow();
    expect(f.counts).toMatchObject({ admissionWrites: 0, listenerWrites: 0 });
  } finally {
    await f.stop();
  }
});

test.each([
  "unavailable readback",
  "publication changes before routing journal",
])("holds committed admission for %s", async (scenario) => {
  const f = await qualifiedFixture({
    publicationControl: { publicationProtocol: 1 },
  });
  try {
    await f.inspect();
    if (scenario === "unavailable readback") {
      f.fault.unavailableReadback = true;
      f.fault.afterAdmission = true;
    } else f.fault.pinBeforeRouting = true;
    await expect(f.apply()).rejects.toThrow();
    expect((await f.read("CONTROL")).servingGeneration).toBe(2);
    expect(await f.readReceipt()).toMatchObject({
      stage: "admission_transferred",
      settlement: "lost_owner_settlement_pending",
    });
    expect(f.counts).toMatchObject({ admissionWrites: 1, listenerWrites: 0 });
  } finally {
    await f.stop();
  }
});

test.each([
  "running source",
  "missing source",
  "actor mismatch",
  "changed epoch",
  "candidate unprotected",
])("refuses %s without admission or routing", async (scenario) => {
  const f = await qualifiedFixture();
  try {
    await f.inspect();
    const original = {
      runtime: await f.read("RUNTIME#old"),
      lease: await f.readLease(),
      voice: await f.readVoice(),
    };
    if (scenario === "running source") f.loss.sourceStatus = "RUNNING";
    if (scenario === "missing source") f.loss.missing = true;
    if (scenario === "actor mismatch") {
      f.packet.actorArn += "-wrong";
      f.options.packetSha256 = bindingHash(f.packet);
    }
    if (scenario === "candidate unprotected") f.state.protected = false;
    if (scenario === "changed epoch") {
      const ctl = await f.read("CONTROL");
      ctl.coordinatorEpoch++;
      await putIntroductionDocument(f.table, ctl);
    }
    await expect(f.apply()).rejects.toThrow();
    expect(f.counts).toMatchObject({ admissionWrites: 0, listenerWrites: 0 });
    expect((await f.read("CONTROL")).servingGeneration).toBe(1);
    expect(await f.readReceipt()).toBeUndefined();
    expect(f.lifecycle.isAcceptingWork()).toBe(false);
    expect(await f.read("RUNTIME#old")).toEqual(original.runtime);
    expect(await f.readLease()).toEqual(original.lease);
    expect(await f.readVoice()).toEqual(original.voice);
  } finally {
    await f.stop();
  }
});

test.each(["beforeAdmission", "afterAdmission", "afterListener"])(
  "preserves once-only behavior for %s uncertainty",
  async (fault) => {
    const f = await qualifiedFixture();
    try {
      await f.inspect();
      f.fault[fault] = true;
      if (fault === "afterAdmission") {
        await expect(f.apply()).resolves.toMatchObject({
          kind: "availability_restored",
        });
        expect(await f.readReceipt()).toMatchObject({
          stage: "availability_restored",
          settlement: "lost_owner_settlement_pending",
        });
        expect(f.counts).toMatchObject({
          admissionWrites: 1,
          listenerWrites: 1,
        });
      } else {
        await expect(f.apply()).rejects.toThrow();
        expect(f.counts.admissionWrites).toBe(1);
        if (fault === "beforeAdmission") {
          expect((await f.read("CONTROL")).servingGeneration).toBe(1);
          expect(await f.readReceipt()).toBeUndefined();
          expect(f.counts.listenerWrites).toBe(0);
          expect(f.lifecycle.isAcceptingWork()).toBe(false);
        } else {
          expect((await f.read("CONTROL")).servingGeneration).toBe(2);
          expect(await f.readReceipt()).toMatchObject({
            stage: "forward_submitted",
            settlement: "lost_owner_settlement_pending",
          });
          expect(f.counts.listenerWrites).toBe(1);
          await expect(f.apply()).rejects.toThrow();
          expect(f.counts).toMatchObject({
            admissionWrites: 1,
            listenerWrites: 1,
          });
        }
      }
    } finally {
      await f.stop();
    }
  },
);

test.each([
  "after inspect",
  "before transaction",
  "after commit with lost acknowledgment",
])(
  "qualification requirement: publication hold %s must stop recovery",
  async (when) => {
    const f = await qualifiedFixture();
    try {
      await f.inspect();
      if (when === "after inspect") await f.addPublicationHold();
      if (when === "before transaction") f.fault.pinBeforeAdmission = true;
      if (when === "after commit with lost acknowledgment") {
        f.fault.pinAfterAdmission = true;
        f.fault.afterAdmission = true;
      }
      await expect(f.apply()).rejects.toThrow();
      expect(f.counts.listenerWrites).toBe(0);
      expect((await f.read("CONTROL")).servingGeneration).toBe(
        when === "after commit with lost acknowledgment" ? 2 : 1,
      );
    } finally {
      await f.stop();
    }
  },
);

test.each([false, true])(
  "nonempty history authority is conditioned, concurrent change=%s",
  async (changed) => {
    const f = await qualifiedFixture({ historyAuthority: true });
    try {
      await f.inspect();
      if (changed)
        await putIntroductionDocument(f.tables.MeetingHistoryTable, {
          guildId: "history-guild",
          channelId_timestamp: "history-channel_time",
          meetingId: "history-meeting",
          status: "complete",
          completionPolicy: { decision: "proceed" },
          audioS3Key: "changed-synthetic-stored",
          ownerInstanceId: "old",
          executionVersion: 1,
        });
      if (changed) {
        await expect(f.apply()).rejects.toThrow();
        expect((await f.read("CONTROL")).servingGeneration).toBe(1);
        expect(await f.readReceipt()).toBeUndefined();
        expect(f.counts.listenerWrites).toBe(0);
      } else
        await expect(f.apply()).resolves.toMatchObject({
          kind: "availability_restored",
        });
    } finally {
      await f.stop();
    }
  },
);
