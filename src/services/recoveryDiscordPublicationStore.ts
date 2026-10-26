import { createDynamoMeetingPublicationRepository } from "../repositories/meetingPublicationRepository";
import { createRecoveryPublicationBarrier } from "./recoveryDiscordPublicationBarrier";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import {
  publicationScopeSchema,
  publicationHistorySchema,
  recoveryPublicationManifestSchema,
  publicationReceiptSchema,
  publicationClaimSchema,
  recoveryDiscordPreviewSchema,
  bindRecoveryPublication,
  recoveryPublicationLocation,
  publicationDigest,
  stablePublicationJson,
  type PublicationScope,
  type PublicationDependencies,
} from "./recoveryDiscordPublicationTypes";

type StoreOptions = {
  dynamo: DynamoDBClient;
  s3: S3Client;
  sts: STSClient;
  scope: PublicationScope;
};
const awsErrorSchema = z.object({
  name: z.string().optional(),
  $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
});
function isMissing(error: unknown) {
  const parsed = awsErrorSchema.safeParse(error);
  return (
    parsed.success &&
    (parsed.data.name === "NoSuchKey" ||
      parsed.data.$metadata?.httpStatusCode === 404)
  );
}

async function verifyClients({ dynamo, s3, sts, scope }: StoreOptions) {
  const clients = [dynamo, s3, sts];
  const regions = await Promise.all(
    clients.map((client) => client.config.region()),
  );
  const attempts = await Promise.all(
    clients.map((client) => client.config.maxAttempts()),
  );
  const credentials = await Promise.all(
    clients.map((client) => client.config.credentials()),
  );
  const identity = credentials.map(
    ({ accessKeyId, secretAccessKey, sessionToken }) => ({
      accessKeyId,
      secretAccessKey,
      sessionToken,
    }),
  );
  if (
    regions.some((region) => region !== scope.region) ||
    attempts.some((value) => value !== 1) ||
    identity.some(
      (value) =>
        stablePublicationJson(value) !== stablePublicationJson(identity[0]),
    )
  )
    throw new Error(
      "Publication clients must share selected region, resolved credentials and maxAttempts=1",
    );
  const response = await sts.send(new GetCallerIdentityCommand({}));
  if (response.Account !== scope.accountId)
    throw new Error("AWS caller account does not match selected account");
}

export async function createRecoveryDiscordPublicationStore(
  options: StoreOptions,
): Promise<
  Pick<
    PublicationDependencies,
    "readHistory" | "readManifest" | "storage" | "publication"
  >
> {
  const scope = publicationScopeSchema.parse(options.scope);
  await verifyClients({ ...options, scope });
  const { dynamo, s3 } = options;
  const tableArn = `arn:aws:dynamodb:${scope.region}:${scope.accountId}:table/`;
  if (scope.table.includes(":") && !scope.table.startsWith(tableArn))
    throw new Error("History table ARN is outside selected account and region");
  function assertScope(selected: PublicationScope) {
    if (
      stablePublicationJson(publicationScopeSchema.parse(selected)) !==
      stablePublicationJson(scope)
    )
      throw new Error("Publication store scope cannot be overridden");
  }
  async function getObject(key: string) {
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: scope.bucket,
          Key: key,
          ExpectedBucketOwner: scope.accountId,
        }),
      );
      if (!response.Body || !response.ETag)
        throw new Error("S3 object body or ETag missing");
      return {
        body: await response.Body.transformToString(),
        etag: response.ETag,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error("Selected S3 object could not be read", { cause: error });
    }
  }
  const readHistory = async (selected: PublicationScope): Promise<unknown> => {
    assertScope(selected);
    const response = await dynamo.send(
      new GetItemCommand({
        TableName: scope.table,
        ConsistentRead: true,
        Key: marshall({
          guildId: scope.guildId,
          channelId_timestamp: scope.meetingKey,
        }),
      }),
    );
    return response.Item ? unmarshall(response.Item) : null;
  };
  const readManifest = async (selected: PublicationScope): Promise<unknown> => {
    assertScope(selected);
    const object = await getObject(scope.recoveryManifestKey);
    if (!object) throw new Error("Selected recovery manifest is missing");
    return JSON.parse(object.body);
  };
  let bound: ReturnType<typeof recoveryPublicationLocation> | undefined;
  async function binding() {
    if (!bound)
      bound = recoveryPublicationLocation(
        scope,
        publicationHistorySchema.parse(await readHistory(scope)),
        recoveryPublicationManifestSchema.parse(await readManifest(scope)),
      );
    return bound;
  }
  async function assertReceiptKey(key: string, write = false) {
    const value = await binding();
    const prefix = write
      ? value.recoveryPrefix
      : `${value.artifactFolder}recovery/`;
    const suffix = key.slice(prefix.length);
    const pattern = write
      ? /^discord-publication\/[a-f0-9]{64}\/receipt\.json$/
      : /^[^/\\]+\/discord-publication\/[a-f0-9]{64}\/receipt\.json$/;
    if (
      !key.startsWith(prefix) ||
      !pattern.test(suffix) ||
      suffix.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Receipt key is outside the bound recovery directory");
  }
  async function assertClaimKey(key: string) {
    if (key !== (await binding()).claimKey)
      throw new Error("Claim key is outside the bound meeting version");
  }
  async function put(
    key: string,
    body: string,
    condition: { kind: "absent" } | { kind: "match"; etag: string },
  ) {
    const response = await s3.send(
      new PutObjectCommand({
        Bucket: scope.bucket,
        Key: key,
        ExpectedBucketOwner: scope.accountId,
        Body: body,
        ContentType: "application/json",
        ...(condition.kind === "absent"
          ? { IfNoneMatch: "*" }
          : { IfMatch: condition.etag }),
      }),
    );
    if (!response.ETag)
      throw new Error("S3 write acknowledgment is missing its ETag");
    return response.ETag;
  }
  async function storedPreview(previewDigest: string) {
    const selected = await binding();
    const object = await getObject(
      `${selected.recoveryPrefix}discord-publication/${previewDigest}/preview.json`,
    );
    if (!object) throw new Error("Durable preview is missing");
    const preview = recoveryDiscordPreviewSchema.parse(JSON.parse(object.body));
    assertScope(preview.scope);
    if (
      preview.kind !== "ready" ||
      publicationDigest(preview) !== previewDigest ||
      preview.previewDigest !== previewDigest ||
      preview.binding.claimKey !== selected.claimKey ||
      preview.binding.recoveryPrefix !== selected.recoveryPrefix ||
      preview.binding.meetingId !== selected.meetingId
    )
      throw new Error(
        "Durable preview identity does not match selected recovery",
      );
    return preview;
  }
  const storage: PublicationDependencies["storage"] = {
    savePreview: async (raw) => {
      const preview = recoveryDiscordPreviewSchema.parse(raw);
      assertScope(preview.scope);
      if (
        preview.kind !== "ready" ||
        publicationDigest(raw) !== preview.previewDigest ||
        stablePublicationJson(preview.binding) !==
          stablePublicationJson(
            bindRecoveryPublication(
              scope,
              publicationHistorySchema.parse(await readHistory(scope)),
              recoveryPublicationManifestSchema.parse(
                await readManifest(scope),
              ),
            ),
          )
      )
        throw new Error("Preview is not bound to selected stored recovery");
      const key = `${preview.binding.recoveryPrefix}discord-publication/${preview.previewDigest}/preview.json`;
      const body = stablePublicationJson(preview);
      try {
        await put(key, body, { kind: "absent" });
      } catch {
        const saved = await getObject(key);
        if (saved?.body !== body)
          throw new Error(
            "Immutable preview could not be confirmed byte-for-byte",
          );
      }
    },
    readReceipt: async (key) => {
      await assertReceiptKey(key);
      const object = await getObject(key);
      return object
        ? {
            value: publicationReceiptSchema.parse(JSON.parse(object.body)),
            etag: object.etag,
          }
        : null;
    },
    saveReceipt: async ({ key, receipt, condition }) => {
      await assertReceiptKey(key, true);
      const value = publicationReceiptSchema.parse(receipt);
      const selected = (await storedPreview(value.previewDigest)).binding;
      if (
        value.meetingId !== selected.meetingId ||
        value.notesVersion !== selected.notesVersion ||
        value.storedFieldsDigest !== selected.storedFieldsDigest ||
        !key.endsWith(`/${value.previewDigest}/receipt.json`)
      )
        throw new Error("Receipt identity is outside selected recovery");
      return put(key, stablePublicationJson(value), condition);
    },
    readClaim: async (key) => {
      await assertClaimKey(key);
      const object = await getObject(key);
      return object
        ? {
            value: publicationClaimSchema.parse(JSON.parse(object.body)),
            etag: object.etag,
          }
        : null;
    },
    writeClaim: async ({ key, claim, condition }) => {
      await assertClaimKey(key);
      const value = publicationClaimSchema.parse(claim);
      const selected = (await storedPreview(value.previewDigest)).binding;
      await assertReceiptKey(value.receiptKey, true);
      if (
        value.meetingId !== selected.meetingId ||
        value.notesVersion !== selected.notesVersion ||
        !value.receiptKey.endsWith(`/${value.previewDigest}/receipt.json`)
      )
        throw new Error("Claim identity is outside selected recovery");
      return put(key, stablePublicationJson(value), condition);
    },
  };
  const publication = createRecoveryPublicationBarrier({
    repository: createDynamoMeetingPublicationRepository(dynamo, scope.table),
    key: { guildId: scope.guildId, channelId_timestamp: scope.meetingKey },
    async validate(history, selected) {
      return (
        stablePublicationJson(
          bindRecoveryPublication(
            scope,
            publicationHistorySchema.parse(history),
            recoveryPublicationManifestSchema.parse(await readManifest(scope)),
          ),
        ) === stablePublicationJson(selected)
      );
    },
  });
  return { readHistory, readManifest, storage, publication };
}
