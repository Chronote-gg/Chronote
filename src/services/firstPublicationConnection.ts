import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  ECSClient,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PermissionsBitField } from "discord.js";
import { createDynamoFirstPublicationRepository } from "../repositories/firstPublicationRepository";
import {
  createFirstPublicationTransport,
  DiscordMessageHttpError,
} from "./discordMessageEditor";
import { inspectFirstPublicationRuntime } from "./firstPublicationRuntime";
import {
  publicationProfileSchema,
  type PublicationProfile,
  type FirstPublicationDependencies,
} from "./firstPublicationTypes";
export async function connectFirstPublication(
  input: PublicationProfile,
  options: {
    stateDirectory: string;
    processId?: string;
    releasesPath?: string;
  },
) {
  if (
    !process.env.AWS_PROFILE &&
    !process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI &&
    !process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  )
    throw Error("Select an explicit operator AWS profile or managed role");
  if (
    process.env.AWS_PROFILE &&
    (process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      process.env.AWS_SESSION_TOKEN)
  )
    throw Error(
      "Remove conflicting environment credentials before selecting the operator profile",
    );
  const profile = publicationProfileSchema.parse(input),
    resolver = new DynamoDBClient({ region: profile.region });
  const credentials = await resolver.config.credentials();
  resolver.destroy();
  const config = {
    region: profile.region,
    maxAttempts: 1,
    credentials,
    ignoreConfiguredEndpointUrls: true,
  };
  const db = new DynamoDBClient(config),
    s3 = new S3Client(config),
    sts = new STSClient(config),
    secrets = new SecretsManagerClient(config),
    ecs = new ECSClient(config);
  const repository = createDynamoFirstPublicationRepository(db, profile);
  let token: Promise<string> | undefined;
  const getToken = () =>
    (token ??= (async () => {
      if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
      if (!profile.tokenSecretId)
        throw Error("Configure the operator bot credential reference");
      if (
        profile.tokenSecretId.startsWith("arn:") &&
        !profile.tokenSecretId.includes(":" + profile.accountId + ":")
      )
        throw Error("Credential account mismatch");
      const value = await secrets.send(
        new GetSecretValueCommand({ SecretId: profile.tokenSecretId }),
      );
      if (!value.SecretString) throw Error("Bot credential unavailable");
      return value.SecretString;
    })());
  async function get(path: string): Promise<unknown> {
    const response = await fetch("https://discord.com/api/v10" + path, {
      method: "GET",
      headers: { Authorization: "Bot " + (await getToken()) },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new DiscordMessageHttpError("read", response.status);
    return response.json();
  }
  const channelSchema = z.object({
    id: z.string(),
    guild_id: z.string(),
    type: z.number(),
    permission_overwrites: z
      .array(
        z.object({
          id: z.string(),
          type: z.number(),
          allow: z.string(),
          deny: z.string(),
        }),
      )
      .default([]),
  });
  const memberSchema = z.object({
    roles: z.array(z.string()),
    communication_disabled_until: z.string().nullable().optional(),
  });
  const roleSchema = z.array(
    z.object({ id: z.string(), permissions: z.string() }),
  );
  const deps: FirstPublicationDependencies = {
    profile,
    processId: options.processId ?? "local:" + randomUUID(),
    now: () => new Date().toISOString(),
    repository,
    identity: async () => {
      const who = await sts.send(new GetCallerIdentityCommand({}));
      if (who.Account !== profile.accountId || who.Arn?.endsWith(":root"))
        throw Error("AWS account or role mismatch");
      return who.Account;
    },
    readObject: async (key) => {
      if (
        !/^ops\/operator-recovery\/[a-f0-9-]+\/[a-f0-9-]+\/(manifest\.json|transcript\.json|notes\.md)$/.test(
          key,
        )
      )
        throw Error("Unexpected recovery object path");
      const r = await s3.send(
        new GetObjectCommand({
          Bucket: profile.bucket,
          Key: key,
          ExpectedBucketOwner: profile.accountId,
        }),
      );
      if (!r.Body) throw Error("Recovery object unavailable");
      return r.Body.transformToString("utf8");
    },
    targetActive: async (key, id) => {
      const r = await db.send(
        new GetItemCommand({
          TableName: profile.activeTable,
          Key: marshall({ guildId: key.guildId }),
          ConsistentRead: true,
        }),
      );
      return r.Item ? unmarshall(r.Item).meetingId === id : false;
    },
    runtime: async () => {
      const releases = JSON.parse(
        await readFile(
          options.releasesPath ??
            resolve(
              __dirname,
              "../../scripts/operator/recovery-publication-releases.json",
            ),
          "utf8",
        ),
      );
      return inspectFirstPublicationRuntime(profile, {
        releases,
        readControl: async () => {
          const r = await db.send(
            new GetItemCommand({
              TableName: profile.controlTable,
              Key: marshall({ pk: "ENV", sk: "CONTROL" }),
              ConsistentRead: true,
            }),
          );
          if (!r.Item) throw Error("Control missing");
          return unmarshall(r.Item);
        },
        listServiceTasks: async (scope) => {
          const service = (
            await ecs.send(
              new DescribeServicesCommand({
                cluster: scope.cluster,
                services: [scope.service],
              }),
            )
          ).services?.[0];
          if (
            !service ||
            service.status !== "ACTIVE" ||
            service.pendingCount ||
            service.runningCount !== service.desiredCount ||
            service.deployments?.length !== 1
          )
            return [];
          const arns: string[] = [];
          let nextToken: string | undefined;
          do {
            const r = await ecs.send(
              new ListTasksCommand({
                cluster: scope.cluster,
                serviceName: scope.service,
                desiredStatus: "RUNNING",
                nextToken,
              }),
            );
            arns.push(...(r.taskArns ?? []));
            nextToken = r.nextToken;
            if (arns.length > 100)
              throw Error("Cohort inspection bound exceeded");
          } while (nextToken);
          if (!arns.length) return [];
          const r = await ecs.send(
            new DescribeTasksCommand({ cluster: scope.cluster, tasks: arns }),
          );
          if (r.failures?.length || r.tasks?.length !== arns.length) return [];
          return r.tasks.map((t) => ({
            taskArn: t.taskArn ?? "",
            imageDigests: (t.containers ?? []).flatMap((c) =>
              c.imageDigest ? [c.imageDigest] : [],
            ),
            ready: t.lastStatus === "RUNNING" && t.healthStatus !== "UNHEALTHY",
          }));
        },
      });
    },
    stopped: async (processId) => {
      const id = z
        .string()
        .regex(/^local:[a-f0-9-]{36}$/)
        .safeParse(processId);
      if (!id.success) return null;
      try {
        const proof = z
          .object({ processId: z.literal(processId), exited: z.literal(true) })
          .strict()
          .parse(
            JSON.parse(
              await readFile(
                resolve(
                  options.stateDirectory,
                  processId.slice(6),
                  "exited.json",
                ),
                "utf8",
              ),
            ),
          );
        return JSON.stringify(proof);
      } catch {
        return null;
      }
    },
    discord: {
      getBotIdentity: async () => {
        const r = z
          .object({ id: z.string(), bot: z.literal(true) })
          .parse(await get("/users/@me"));
        return r;
      },
      inspectDestination: async (guildId, channelId) => {
        const channel = channelSchema.parse(
          await get("/channels/" + channelId),
        );
        if (channel.guild_id !== guildId || channel.type !== 0)
          return {
            allowed: false,
            reason:
              "Stored destination is unavailable or is not an ordinary text channel",
          };
        const bot = await deps.discord.getBotIdentity();
        const [roles, member] = await Promise.all([
          get("/guilds/" + guildId + "/roles").then((v) => roleSchema.parse(v)),
          get("/guilds/" + guildId + "/members/" + bot.id).then((v) =>
            memberSchema.parse(v),
          ),
        ]);
        if (
          member.communication_disabled_until &&
          Date.parse(member.communication_disabled_until) > Date.now()
        )
          return { allowed: false, reason: "Bot timeout is active" };
        const ids = new Set([guildId, ...member.roles]);
        let bits = 0n;
        for (const r of roles) if (ids.has(r.id)) bits |= BigInt(r.permissions);
        if (
          !new PermissionsBitField(bits).has(
            PermissionsBitField.Flags.Administrator,
          )
        ) {
          const everyone = channel.permission_overwrites.find(
            (o) => o.type === 0 && o.id === guildId,
          );
          if (everyone)
            bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
          let allow = 0n,
            deny = 0n;
          for (const o of channel.permission_overwrites)
            if (o.type === 0 && o.id !== guildId && ids.has(o.id)) {
              allow |= BigInt(o.allow);
              deny |= BigInt(o.deny);
            }
          bits = (bits & ~deny) | allow;
          const own = channel.permission_overwrites.find(
            (o) => o.type === 1 && o.id === bot.id,
          );
          if (own) bits = (bits & ~BigInt(own.deny)) | BigInt(own.allow);
        }
        const permissions = new PermissionsBitField(bits),
          required = [
            "ViewChannel",
            "ReadMessageHistory",
            "SendMessages",
            "EmbedLinks",
          ] as const;
        const missing = required.filter(
          (p) => !permissions.has(PermissionsBitField.Flags[p]),
        );
        return {
          allowed: !missing.length,
          reason: missing.length ? "Missing " + missing.join(", ") : undefined,
        };
      },
      duplicateEvidence: async (key, channelId) => {
        const row = await repository.getStrong(key);
        if (!row) throw Error("Meeting missing");
        const millis = Date.parse(row.timestamp);
        if (!Number.isFinite(millis) || millis < 1420070400000)
          throw Error("Invalid meeting time");
        const around = ((BigInt(millis) - 1420070400000n) << 22n).toString(),
          bot = await deps.discord.getBotIdentity();
        const [near, latest] = await Promise.all([
          get(
            "/channels/" + channelId + "/messages?limit=100&around=" + around,
          ),
          get("/channels/" + channelId + "/messages?limit=100"),
        ]);
        const messages = z
          .array(
            z.object({
              author: z.object({ id: z.string() }),
              embeds: z.array(z.record(z.string(), z.unknown())),
              components: z.array(z.unknown()).default([]),
            }),
          )
          .parse([
            ...z.array(z.unknown()).parse(near),
            ...z.array(z.unknown()).parse(latest),
          ]);
        const suffix = encodeURIComponent(key.channelId_timestamp),
          path = "/portal/meetings/" + key.guildId + "/" + suffix;
        return {
          ambiguous: messages.some(
            (m) =>
              m.author.id === bot.id &&
              m.embeds.some(
                (e) =>
                  typeof e.title === "string" && /notes|summary/i.test(e.title),
              ) &&
              (JSON.stringify(m).includes(path) ||
                JSON.stringify(m).includes(key.channelId_timestamp) ||
                m.embeds.some(
                  (e) =>
                    typeof e.description === "string" &&
                    !!row.notes &&
                    e.description.includes(row.notes),
                )),
          ),
          bounds: "100 messages around original start plus latest 100",
        };
      },
      getMessage: async (channelId, messageId) =>
        createFirstPublicationTransport({ token: await getToken() }).getMessage(
          { channelId, messageId, signal: AbortSignal.timeout(15000) },
        ),
      createNotesMessage: async (input) =>
        createFirstPublicationTransport({
          token: await getToken(),
        }).createNotesMessage(input),
    },
  };
  return {
    deps,
    close: () => {
      db.destroy();
      s3.destroy();
      sts.destroy();
      secrets.destroy();
      ecs.destroy();
    },
  };
}
