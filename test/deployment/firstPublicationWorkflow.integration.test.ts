/** @jest-environment node */
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { workflowFixture } from "../services/firstPublication.harness";
import { createDynamoFirstPublicationRepository } from "../../src/repositories/firstPublicationRepository";
import { previewFirstPublication } from "../../src/services/firstPublicationPlan";
import { applyFirstPublication } from "../../src/services/firstPublicationService";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { publicationSnapshot } from "../../src/types/meetingPublication";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
test("real Dynamo first publication is atomic, pinned, read back and idempotent", async () => {
  const w = workflowFixture(),
    db = await publicationDynamoFixture(w.key);
  try {
    const profile = publicationProfile(w, db);
    await seedPublication(w, db, profile);
    connectPublication(w, db, profile);
    const p = await previewFirstPublication([w.key], w.deps);
    const r = await applyFirstPublication(p, p.digest, w.deps);
    expect(r.meetings[0].reason).toBeUndefined();
    expect(r.meetings[0]).toMatchObject({
      outcome: "verified",
      messageIds: ["901"],
    });
    expect(
      (await applyFirstPublication(p, p.digest, w.deps)).meetings[0].outcome,
    ).toBe("already_published");
    expect(w.posts).toHaveLength(1);
    expect(await w.deps.repository.getStrong(w.key)).toMatchObject({
      notes: w.row.notes,
      notesMessageIds: ["901"],
      updateDelivery: { policy: { kind: "held" } },
    });
  } finally {
    await db.close();
  }
});
test("real Dynamo concurrent archive exclusion and incompatible deployment ordering", async () => {
  const w = workflowFixture(),
    db = await publicationDynamoFixture(w.key);
  try {
    const profile = publicationProfile(w, db);
    await seedPublication(w, db, profile);
    connectPublication(w, db, profile);
    w.deps.discord.createNotesMessage = async () => {
      const held = await db.read();
      if (!held?.updateDelivery) throw Error("Held source missing");
      const saved = await db.updates.updateContentAndDelivery({
        key: w.key,
        expectedContentRevision: held.contentRevision ?? 0,
        expectedDeliveryRevision: held.updateDelivery.revision,
        expectedPublication: publicationSnapshot(held),
        mutation: { kind: "notes", notes: "Racing canonical save" },
        mutationId: "racing-save",
        at: Math.floor(Date.now() / 1000),
        nextDelivery: held.updateDelivery,
      });
      expect(saved.kind).toBe("conflict");
      expect((await db.read())?.notes).toBe(w.row.notes);
      await expect(
        db.client.send(
          new UpdateItemCommand({
            TableName: profile.historyTable,
            Key: marshall(w.key),
            UpdateExpression: "SET archivedAt=:now",
            ConditionExpression:
              "attribute_not_exists(publicationRepair.#kind) OR publicationRepair.#kind <> :running",
            ExpressionAttributeNames: { "#kind": "kind" },
            ExpressionAttributeValues: marshall({
              ":now": "2026-11-03T00:00:00Z",
              ":running": "running",
            }),
          }),
        ),
      ).rejects.toThrow();
      await expect(
        db.client.send(
          new UpdateItemCommand({
            TableName: profile.controlTable,
            Key: marshall({ pk: "ENV", sk: "CONTROL" }),
            UpdateExpression: "SET publicationTransition=:transition",
            ConditionExpression:
              "attribute_not_exists(publicationPins) OR size(publicationPins)=:zero",
            ExpressionAttributeValues: marshall({
              ":transition": { runToken: "deploy", images: [] },
              ":zero": 0,
            }),
          }),
        ),
      ).rejects.toThrow();
      throw Error("synthetic lost response");
    };
    const p = await previewFirstPublication([w.key], w.deps);
    expect(
      (await applyFirstPublication(p, p.digest, w.deps)).meetings[0].outcome,
    ).toBe("uncertain");
  } finally {
    await db.close();
  }
});

test("repeatable batch handles two synthetic recoveries, pagination and an archived skip", async () => {
  const w = workflowFixture(),
    db = await publicationDynamoFixture(w.key);
  try {
    const profile = publicationProfile(w, db);
    await db.put(profile.controlTable, w.store.control);
    const fixtures = [workflowFixture(), workflowFixture(), workflowFixture()],
      objects = new Map<string, string>();
    for (const [i, f] of fixtures.entries()) {
      f.row.guildId = String(123 + i);
      f.row.channelId = String(456 + i);
      f.row.channelId_timestamp = f.row.channelId + "#" + f.row.timestamp;
      f.key = {
        guildId: f.row.guildId,
        channelId_timestamp: f.row.channelId_timestamp,
      };
      f.row.meetingId = "22222222-2222-4222-8222-22222222222" + String(i + 2);
      const prefix =
        "ops/operator-recovery/11111111-1111-4111-8111-111111111111/" +
        f.row.meetingId +
        "/";
      f.row.transcriptS3Key = prefix + "transcript.json";
      f.row.operatorRecovery!.manifestS3Key = prefix + "manifest.json";
      f.manifest.meetingId = f.row.meetingId;
      f.manifest.key = f.key;
      for (const object of f.manifest.objects)
        object.key = prefix + object.key.split("/").at(-1);
      if (i === 1) {
        f.row.notes = f.objects.notes = "Long approved text. ".repeat(900);
        const { hash } = await import("../services/firstPublication.fixture");
        f.row.operatorRecovery!.notesSha256 = hash(f.objects.notes);
        f.manifest.objects[0].sha256 = hash(f.objects.notes);
      }
      if (i === 2) f.row.archivedAt = "2026-11-02T00:00:00Z";
      else {
        objects.set(prefix + "manifest.json", JSON.stringify(f.manifest));
        objects.set(prefix + "notes.md", f.objects.notes);
        objects.set(prefix + "transcript.json", f.objects.transcript);
      }
      await db.put(profile.historyTable, f.row);
    }
    connectPublication(w, db, profile);
    w.deps.readObject = async (key) => {
      const s = objects.get(key);
      if (!s) throw Error("Archived object must not be read");
      return s;
    };
    const p = await previewFirstPublication(
      fixtures.map((f) => f.key),
      w.deps,
    );
    expect(p.ready).toBe(true);
    const applied = await applyFirstPublication(p, p.digest, w.deps);
    expect(
      applied.meetings.filter((m) => m.outcome === "verified"),
    ).toHaveLength(2);
    expect(
      applied.meetings.filter((m) => m.outcome === "skipped_archived"),
    ).toHaveLength(1);
    expect(w.posts.length).toBeGreaterThan(2);
    const posts = w.posts.length;
    expect(
      (await applyFirstPublication(p, p.digest, w.deps)).meetings.filter(
        (m) => m.outcome === "already_published",
      ),
    ).toHaveLength(2);
    expect(w.posts).toHaveLength(posts);
  } finally {
    await db.close();
  }
});
test("lost final registration acknowledgement is resolved by strong readback, never another POST", async () => {
  const w = workflowFixture(),
    db = await publicationDynamoFixture(w.key);
  try {
    const profile = publicationProfile(w, db);
    await seedPublication(w, db, profile);
    connectPublication(w, db, profile);
    let injected = false;
    db.client.middlewareStack.add(
      (next) => async (args) => {
        const result = await next(args);
        if (
          args.input &&
          Reflect.has(args.input, "TransactItems") &&
          !injected &&
          (await db.read())?.notesMessageIds?.length
        ) {
          injected = true;
          throw Error("synthetic acknowledgement loss");
        }
        return result;
      },
      { step: "initialize", name: "lostAck" },
    );
    const p = await previewFirstPublication([w.key], w.deps);
    expect(
      (await applyFirstPublication(p, p.digest, w.deps)).meetings[0].outcome,
    ).toBe("verified");
    expect(injected).toBe(true);
    expect(w.posts).toHaveLength(1);
  } finally {
    await db.close();
  }
});

test("real Dynamo pin acquisition and incompatible reservation have exactly one winner", async () => {
  const w = workflowFixture(),
    db = await publicationDynamoFixture(w.key);
  try {
    const profile = publicationProfile(w, db);
    await seedPublication(w, db, profile);
    const repo = createDynamoFirstPublicationRepository(db.client, profile);
    const p = await previewFirstPublication([w.key], w.deps),
      m = p.meetings[0];
    if (m.outcome !== "ready") throw Error("not ready");
    const receipt = {
      schemaVersion: 1 as const,
      runId: "race",
      generation: 1,
      authority: m.binding.authority,
      key: w.key,
      planDigest: p.digest,
      sourceDigest: m.binding.sourceDigest,
      channelId: m.binding.channelId,
      botId: m.binding.botId,
      payloads: m.binding.payloads,
      pages: m.binding.payloads.map(() => ({ kind: "prepared" as const })),
      ownerState: "running" as const,
      outcome: "pending" as const,
      updatedAt: w.deps.now(),
      processId: "test",
    };
    const reservation = db.client
      .send(
        new UpdateItemCommand({
          TableName: profile.controlTable,
          Key: marshall({ pk: "ENV", sk: "CONTROL" }),
          UpdateExpression: "SET publicationTransition=:transition",
          ConditionExpression:
            "attribute_not_exists(publicationPins) OR size(publicationPins)=:zero",
          ExpressionAttributeValues: marshall({
            ":transition": { runToken: "deployment", images: [] },
            ":zero": 0,
          }),
        }),
      )
      .then(
        () => "owned",
        () => "stale",
      );
    const outcomes = await Promise.all([
      repo.acquire({
        receipt,
        snapshot: m.binding.snapshot,
        runtime: {
          kind: "compatible",
          generation: 1,
          control: w.store.control,
        },
      }),
      reservation,
    ]);
    expect(outcomes.filter((x) => x === "owned")).toHaveLength(1);
  } finally {
    await db.close();
  }
});

function publicationProfile(
  w: ReturnType<typeof workflowFixture>,
  db: Awaited<ReturnType<typeof publicationDynamoFixture>>,
) {
  return {
    ...w.profile,
    historyTable: db.tables.meetingHistory,
    controlTable: db.tables.deploymentControl,
    activeTable: db.tables.activeMeeting,
  };
}
function connectPublication(
  w: ReturnType<typeof workflowFixture>,
  db: Awaited<ReturnType<typeof publicationDynamoFixture>>,
  profile: ReturnType<typeof publicationProfile>,
) {
  w.deps.profile = profile;
  w.deps.repository = createDynamoFirstPublicationRepository(
    db.client,
    profile,
  );
  w.deps.runtime = async () => {
    const r = await db.client.send(
      new GetItemCommand({
        TableName: profile.controlTable,
        Key: marshall({ pk: "ENV", sk: "CONTROL" }),
        ConsistentRead: true,
      }),
    );
    const control = unmarshall(r.Item!);
    return { kind: "compatible", generation: 1, control };
  };
}

async function seedPublication(
  w: ReturnType<typeof workflowFixture>,
  db: Awaited<ReturnType<typeof publicationDynamoFixture>>,
  profile: ReturnType<typeof publicationProfile>,
) {
  await db.put(profile.historyTable, w.row);
  await db.put(profile.controlTable, w.store.control);
}
