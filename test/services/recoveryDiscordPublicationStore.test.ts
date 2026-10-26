/** @jest-environment node */
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { STSClient } from "@aws-sdk/client-sts";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createRecoveryDiscordPublicationStore } from "../../src/services/recoveryDiscordPublicationStore";
import {
  applyRecoveryDiscordPublication as apply,
  reconcileRecoveryDiscordPublication as reconcile,
  previewRecoveryDiscordPublication,
} from "../../src/services/recoveryDiscordPublication";
import { fixture, input } from "./recoveryDiscordPublication.fixture";

function setup() {
  const f = fixture();
  const credentials = {
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic",
  };
  const config = { region: input.region, credentials, maxAttempts: 1 };
  const dynamo = new DynamoDBClient(config);
  const s3 = new S3Client(config);
  const sts = new STSClient(config);
  const identity = jest.fn(async () => ({ Account: input.accountId }));
  jest.spyOn(sts, "send").mockImplementation(identity);
  const persistedHistory = structuredClone(f.history);
  const history = jest.fn(async (command: unknown) => {
    if (command instanceof GetItemCommand)
      return { Item: marshall(persistedHistory) };
    if (command instanceof UpdateItemCommand) {
      const names = command.input.ExpressionAttributeNames ?? {};
      const values = unmarshall(command.input.ExpressionAttributeValues ?? {});
      const expression = command.input.UpdateExpression ?? "";
      const set = expression.match(/SET (.*?)(?: REMOVE|$)/)?.[1];
      for (const assignment of set?.split(", ") ?? []) {
        const [name, value] = assignment.split(" = ");
        Object.assign(persistedHistory, { [names[name]]: values[value] });
      }
      const remove = expression.match(/REMOVE (.*)/)?.[1];
      for (const name of remove?.split(", ") ?? [])
        Reflect.deleteProperty(persistedHistory, names[name]);
      return { $metadata: {} };
    }
    throw new Error("Unexpected Dynamo operation");
  });
  jest.spyOn(dynamo, "send").mockImplementation(history);
  const objects = new Map<string, { body: string; etag: string }>();
  objects.set(input.recoveryManifestKey, {
    body: JSON.stringify(f.manifest),
    etag: "manifest",
  });
  let revision = 0;
  const send = jest.fn(async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (!object)
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return {
        ETag: object.etag,
        Body: { transformToString: async () => object.body },
        $metadata: {},
      };
    }
    if (command instanceof PutObjectCommand) {
      const old = objects.get(command.input.Key!);
      if (
        command.input.IfNoneMatch === "*"
          ? old
          : command.input.IfMatch !== old?.etag
      )
        throw Object.assign(new Error("conflict"), {
          name: "PreconditionFailed",
        });
      const etag = `etag-${++revision}`;
      objects.set(command.input.Key!, {
        body: String(command.input.Body),
        etag,
      });
      return { ETag: etag, $metadata: {} };
    }
    throw new Error("unexpected AWS operation");
  });
  jest.spyOn(s3, "send").mockImplementation(send);
  const create = () =>
    createRecoveryDiscordPublicationStore({ dynamo, s3, sts, scope: input });
  return { ...f, dynamo, s3, sts, identity, history, objects, send, create };
}

test("consistent exact history reads and owner-bound S3 reads", async () => {
  const f = setup();
  const store = await f.create();
  expect(await store.readHistory(input)).toEqual(await f.deps.readHistory());
  const call = f.history.mock.calls[0][0];
  expect(call).toBeInstanceOf(GetItemCommand);
  if (!(call instanceof GetItemCommand))
    throw new Error("Expected consistent history read");
  expect(call.input).toEqual({
    TableName: input.table,
    ConsistentRead: true,
    Key: marshall({
      guildId: input.guildId,
      channelId_timestamp: input.meetingKey,
    }),
  });
  await store.readManifest(input);
  const manifestRead = f.send.mock.calls[0][0];
  if (!(manifestRead instanceof GetObjectCommand))
    throw new Error("Expected manifest object read");
  expect(manifestRead.input).toMatchObject({
    Bucket: input.bucket,
    Key: input.recoveryManifestKey,
    ExpectedBucketOwner: input.accountId,
  });
});

test("wrong actual account is rejected before data access", async () => {
  const f = setup();
  f.identity.mockResolvedValue({ Account: "999999999999" });
  await expect(f.create()).rejects.toThrow();
  expect(f.history).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

test("different resolved credentials, region or retry policy are rejected", async () => {
  const f = setup();
  const cases = [
    {
      region: "us-west-2",
      credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
      maxAttempts: 1,
    },
    {
      region: input.region,
      credentials: { accessKeyId: "other", secretAccessKey: "synthetic" },
      maxAttempts: 1,
    },
    {
      region: input.region,
      credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
      maxAttempts: 3,
    },
  ];
  for (const config of cases) {
    await expect(
      createRecoveryDiscordPublicationStore({
        dynamo: f.dynamo,
        s3: new S3Client(config),
        sts: f.sts,
        scope: input,
      }),
    ).rejects.toThrow();
  }
  expect(f.identity).not.toHaveBeenCalled();
});

test("scope overrides and unbound object paths are rejected", async () => {
  const f = setup();
  const store = await f.create();
  await expect(
    store.readHistory({ ...input, table: "other" }),
  ).rejects.toThrow();
  await expect(
    store.storage.readReceipt("elsewhere/receipt.json"),
  ).rejects.toThrow();
  await expect(
    store.storage.readClaim("elsewhere/claim.json"),
  ).rejects.toThrow();
});

test("immutable preview saves exactly once and rejects conflicting bytes", async () => {
  const f = setup();
  const store = await f.create();
  const preview = await previewRecoveryDiscordPublication(input, f.deps);
  await store.storage.savePreview(preview);
  await store.storage.savePreview(preview);
  const key = `${preview.binding!.recoveryPrefix}discord-publication/${preview.previewDigest}/preview.json`;
  expect(f.objects.get(key)?.body).toBeDefined();
  f.objects.set(key, { body: "different bytes", etag: "different" });
  await expect(store.storage.savePreview(preview)).rejects.toThrow();
  const writes = f.send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof PutObjectCommand);
  for (const command of writes)
    expect(command.input).toMatchObject({
      IfNoneMatch: "*",
      ExpectedBucketOwner: input.accountId,
    });
});

test("claims use conditional put and failed ETags never overwrite", async () => {
  const f = setup();
  const store = await f.create();
  const preview = await previewRecoveryDiscordPublication(input, f.deps);
  await store.storage.savePreview(preview);
  const key = preview.binding!.claimKey;
  const claim = {
    schemaVersion: 1 as const,
    runId: "one",
    previewDigest: preview.previewDigest,
    meetingId: preview.binding!.meetingId,
    notesVersion: preview.binding!.notesVersion,
    state: "running" as const,
    receiptKey: `${preview.binding!.recoveryPrefix}discord-publication/${preview.previewDigest}/receipt.json`,
    unresolvedMessageIds: [],
  };
  const etag = await store.storage.writeClaim({
    key,
    claim,
    condition: { kind: "absent" },
  });
  await expect(
    store.storage.writeClaim({
      key,
      claim: { ...claim, runId: "two" },
      condition: { kind: "absent" },
    }),
  ).rejects.toThrow();
  await expect(
    store.storage.writeClaim({
      key,
      claim: { ...claim, runId: "two" },
      condition: { kind: "match", etag: "wrong" },
    }),
  ).rejects.toThrow();
  expect((await store.storage.readClaim(key))?.value.runId).toBe("one");
  expect((await store.storage.readClaim(key))?.etag).toBe(etag);
});
async function publication(f: ReturnType<typeof setup>) {
  const store = await f.create();
  const preview = await previewRecoveryDiscordPublication(input, f.deps);
  const editEmbeds = jest.fn(
    async ({
      messageId,
      embeds,
    }: {
      messageId: string;
      embeds: Array<Record<string, unknown>>;
    }) => {
      f.messages.get(messageId)!.embeds = embeds;
      return "acknowledged" as const;
    },
  );
  return {
    preview,
    deps: { ...f.deps, ...store, discord: { ...f.deps.discord, editEmbeds } },
  };
}

test.each([
  ["claim", true],
  ["claim", false],
  ["intent", true],
  ["intent", false],
] as const)(
  "real store loses %s acknowledgment, persisted=%s",
  async (stage, persisted) => {
    const f = setup();
    const p = await publication(f);
    const send = f.send.getMockImplementation()!;
    let interrupted = false;
    f.send.mockImplementation(async (command) => {
      if (
        !interrupted &&
        command instanceof PutObjectCommand &&
        (stage === "claim"
          ? command.input.Key!.includes("/claims/")
          : command.input.Key!.endsWith("receipt.json") &&
            String(command.input.Body).includes('"state":"submitted"'))
      ) {
        interrupted = true;
        if (persisted) await send(command);
        throw new Error("lost storage acknowledgment");
      }
      return send(command);
    });
    if (persisted)
      expect((await apply(p.preview, p.deps)).status).toBe("verified");
    else {
      await expect(apply(p.preview, p.deps)).rejects.toThrow();
      expect(p.deps.discord.editEmbeds).not.toHaveBeenCalled();
    }
  },
);

test("reopened store reconciles an old approved version after current notes change", async () => {
  const f = setup();
  const p = await publication(f);
  await apply(p.preview, p.deps);
  const changed = {
    ...(await f.deps.readHistory()),
    notesVersion: 3,
    notes: "Later edit",
  };
  f.history.mockResolvedValue({ Item: marshall(changed) });
  f.deps.readHistory.mockResolvedValue(changed);
  const reopened = await f.create();
  const result = await reconcile(p.preview, { ...p.deps, ...reopened });
  expect(result.status).toBe("superseded");
  expect(p.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});
