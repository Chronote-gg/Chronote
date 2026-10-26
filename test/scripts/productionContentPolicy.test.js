/** @jest-environment node */
import { readFileSync } from "node:fs";
import { test, expect } from "@jest/globals";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import {
  contentPolicy,
  contentSessionRequest,
  validateContentSession,
  contentPreflight,
} from "../../scripts/deployment/production-content-policy.cjs";
const owner = "11111111-2222-4333-8444-555555555555";
const iamMatches = (pattern, resource) =>
  new RegExp(
    `^${[...pattern].map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`,
  ).test(resource);

test("IAM wildcards cannot reach a context object with an audio source or a different owner", () => {
  const m = completeManifest();
  const policy = contentPolicy(m, 0, "1970-01-01T00:02:00.000Z", owner);
  const audio = policy.Statement[0].Resource.find((value) =>
    value.endsWith("/audio/*"),
  );
  const folder = audio.split("checkpoints/v1/")[0];
  const attempts = [
    `${folder}checkpoints/v1/1-${owner}/context/audio/1-checksum`,
    `${folder}checkpoints/v1/1-other/audio/source/1-checksum`,
  ];
  for (const key of attempts)
    expect(
      policy.Statement[0].Resource.some((pattern) => iamMatches(pattern, key)),
    ).toBe(false);
  expect(
    iamMatches(
      audio,
      `${folder}checkpoints/v1/1-${owner}/audio/user/1-checksum`,
    ),
  ).toBe(true);
});

test("per-fixture narrowing retains exact class KMS contexts and refuses path injection and oversize", () => {
  const m = completeManifest();
  m.acceptance.storageKeyArn =
    "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
  const reservedAt = "1970-01-01T00:02:00.000Z";
  const first = contentPolicy(m, 0, reservedAt, owner);
  const second = contentPolicy(m, 1, reservedAt, owner);
  expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(2048);
  expect(first.Statement[0].Action).toEqual([
    "s3:GetObject",
    "s3:GetObjectVersion",
  ]);
  expect(
    first.Statement[1].Condition.StringLike["kms:EncryptionContext:aws:s3:arn"],
  ).toEqual(first.Statement[0].Resource);
  expect(first.Statement[0].Resource).toHaveLength(3);
  expect(
    first.Statement[0].Resource.some((r) => r.includes("/transcription/")),
  ).toBe(false);
  expect(
    first.Statement[0].Resource.every(
      (r) => !r.includes("context") && r.includes("1970-01-01T00-02-00.000Z/"),
    ),
  ).toBe(true);
  for (const mutation of [
    (v) => {
      v.resources.artifactPrefixes = ["a/../b/"];
    },
    (v) => {
      v.resources.artifactPrefixes = ["record*/"];
    },
    (v) => {
      v.handoff.grants[0].meetingId = "other/fixture";
    },
    (v) => {
      v.acceptance.storageKeyArn =
        "arn:aws:kms:us-east-1:123456789012:alias/key";
    },
    (v) => {
      v.acceptance.storageKeyArn =
        "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555";
    },
    (v) => {
      v.resources.artifactPrefixes = ["a".repeat(500) + "/"];
    },
  ]) {
    const other = structuredClone(m);
    mutation(other);
    expect(() => contentPolicy(other, 0, reservedAt, owner)).toThrow();
  }
  expect(contentPreflight(m).policyCharacters.every((n) => n <= 2048)).toBe(
    true,
  );
});

test("requested and returned narrowed sessions stay within original validity and own fixture", () => {
  const m = completeManifest();
  m.acceptance.storageKeyArn =
    "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
  const request = contentSessionRequest(
    m,
    0,
    "1970-01-01T00:02:00.000Z",
    owner,
    200,
  );
  expect(request.DurationSeconds).toBe(3600);
  const response = {
    AssumedRoleUser: {
      Arn: `arn:aws:sts::${m.identity.accountId}:assumed-role/acceptance-reader/${request.RoleSessionName}`,
    },
    Credentials: {
      AccessKeyId: "dummy",
      SecretAccessKey: "dummy",
      SessionToken: "dummy",
      Expiration: new Date(3800 * 1000).toISOString(),
    },
  };
  expect(
    validateContentSession(
      m,
      0,
      "1970-01-01T00:02:00.000Z",
      owner,
      request,
      response,
      200,
    ).expiresAt,
  ).toBe(3800);
  for (const now of [m.validUntil - 899, m.validUntil])
    expect(() =>
      contentSessionRequest(m, 0, "1970-01-01T00:02:00.000Z", owner, now),
    ).toThrow();
  expect(() =>
    validateContentSession(
      m,
      1,
      "1970-01-01T00:02:00.000Z",
      owner,
      request,
      response,
      200,
    ),
  ).toThrow();
  expect(() =>
    validateContentSession(
      m,
      0,
      "1970-01-01T00:02:00.000Z",
      owner,
      { ...request, Policy: undefined },
      response,
      200,
    ),
  ).toThrow();
  expect(() =>
    validateContentSession(
      m,
      0,
      "1970-01-01T00:02:00.000Z",
      owner,
      request,
      response,
      3800,
    ),
  ).toThrow();
  response.Credentials.Expiration = new Date(
    (m.validUntil + 1) * 1000,
  ).toISOString();
  expect(() =>
    validateContentSession(
      m,
      0,
      "1970-01-01T00:02:00.000Z",
      owner,
      request,
      response,
      200,
    ),
  ).toThrow();
  m.acceptance.prepareDeadline = m.validUntil - 899;
  expect(() => contentPreflight(m)).toThrow();
});

// These patterns come from the actual HCL declarations; Terraform mock tests check the rendered policy.
function baseScope(m) {
  const source = readFileSync("_infra/production-acceptance.tf", "utf8");
  const timestamp = source.match(/fixture\.meeting_id}_([^"/]+)\//)[1];
  const attempt = source.match(
    /production_acceptance_attempt\s*=\s*"([^"]+)"/,
  )[1];
  const suffixes = [
    ...source.matchAll(
      /"\$\{folder}(\$\{local\.production_acceptance_attempt})?([^"]+)"/g,
    ),
  ].map(([, checkpoint, suffix]) => (checkpoint ? attempt : "") + suffix);
  const folders = m.handoff.grants.map(
    (g) =>
      `arn:aws:s3:::${m.resources.bucket}/${m.resources.artifactPrefixes[0]}${g.guildId}/${g.voiceChannelId}_${g.meetingId}_${timestamp}/`,
  );
  return {
    allow: folders.flatMap((folder) =>
      suffixes
        .filter(
          (s) => !s.includes("/context/") && !s.includes("/transcription/"),
        )
        .map((s) => folder + s),
    ),
    deny: folders.flatMap((folder) =>
      suffixes
        .filter((s) => s.includes("/context/") || s.includes("/transcription/"))
        .map((s) => folder + s),
    ),
  };
}
function concreteAudioResource(pattern) {
  expect(pattern).toMatch(/^[^*]*\*$/);
  return `${pattern.slice(0, -1)}user/1-hash`;
}
function effective(
  scope,
  session,
  key,
  service = "s3.us-east-1.amazonaws.com",
  account = "123456789012",
) {
  const match = (patterns) =>
    patterns.some((pattern) => iamMatches(pattern, key));
  const base = match(scope.allow) && !match(scope.deny);
  return {
    s3: base && match(session.Statement[0].Resource),
    kms:
      base &&
      service === "s3.us-east-1.amazonaws.com" &&
      account === "123456789012" &&
      match(
        session.Statement[1].Condition.StringLike[
          "kms:EncryptionContext:aws:s3:arn"
        ],
      ),
  };
}

test("effective base and mandatory session intersection excludes other fixture, timestamp, owner and denied classes", () => {
  const m = completeManifest(),
    scope = baseScope(m);
  const session = contentPolicy(m, 0, "1970-01-01T00:02:00.000Z", owner);
  expect(scope.allow).toHaveLength(6);
  expect(scope.deny).toHaveLength(4);
  const audio = concreteAudioResource(session.Statement[0].Resource[2]);
  expect(effective(scope, session, audio)).toEqual({ s3: true, kms: true });
  for (const key of [
    audio.replace(m.handoff.grants[0].meetingId, m.handoff.grants[1].meetingId),
    audio.replace("00-02-00", "00-02-01"),
    audio.replace(owner, "11111111-2222-4333-8444-666666666666"),
    audio.replace("/audio/", "/context/audio/"),
    audio.replace("/audio/", "/transcription/"),
  ])
    expect(effective(scope, session, key)).toEqual({ s3: false, kms: false });
  expect(
    effective(scope, session, audio, "ec2.us-east-1.amazonaws.com").kms,
  ).toBe(false);
  expect(effective(scope, session, audio, undefined, "000000000000").kms).toBe(
    false,
  );
  expect(effective(scope, session, audio, "", "").kms).toBe(false);
});

test("IAM question marks cross slash and explicit context denial wins even when base allows a malformed owner", () => {
  const m = completeManifest(),
    scope = baseScope(m);
  expect(iamMatches("a?b", "a/b")).toBe(true);
  const shapedOwner = "context/audio/xx-xxxx-4xxx-xxxx-xxxxxxxxxxxx";
  // Equal-width substitutions demonstrate that base shapes do not validate UUID or ISO semantics.
  const allowed = concreteAudioResource(scope.allow[2].replaceAll("?", "x"));
  expect(scope.allow.some((pattern) => iamMatches(pattern, allowed))).toBe(
    true,
  );
  expect(() =>
    contentPolicy(m, 0, "xxxx-xx-xxTxx:xx:xx.xxxZ", owner),
  ).toThrow();
  expect(() =>
    contentPolicy(m, 0, "1970-01-01T00:02:00.000Z", shapedOwner),
  ).toThrow();
  const slashOwner = "xxxxxxxx-xxxx-4xxx-xxxx-xx/context/x";
  expect(slashOwner.length).toBe(36);
  const key = concreteAudioResource(
    scope.allow[2]
      .replace("????????-????-4???-????-????????????", slashOwner)
      .replaceAll("?", "0"),
  );
  expect(scope.allow.some((pattern) => iamMatches(pattern, key))).toBe(true);
  expect(scope.deny.some((pattern) => iamMatches(pattern, key))).toBe(true);
  const broadSession = {
    Statement: [
      { Resource: ["*"] },
      {
        Condition: {
          StringLike: { "kms:EncryptionContext:aws:s3:arn": ["*"] },
        },
      },
    ],
  };
  expect(effective(scope, broadSession, key)).toEqual({
    s3: false,
    kms: false,
  });
});

test("history base IAM limits guild partitions and attributes but cannot distinguish sort keys", () => {
  const m = completeManifest();
  const source = readFileSync("_infra/production-acceptance.tf", "utf8");
  const attributes = JSON.parse(
    source.match(
      /production_acceptance_history_attributes\s*=\s*(\[[^\n]+\])/,
    )[1],
  );
  const permitted = (key, selected) =>
    m.handoff.grants.some((g) => g.guildId === key.guildId) &&
    selected.length > 0 &&
    selected.every((name) => attributes.includes(name));
  expect(
    permitted(
      { guildId: m.handoff.grants[0].guildId, channelId_timestamp: "approved" },
      ["notes", "fixtureInput"],
    ),
  ).toBe(true);
  expect(
    permitted(
      {
        guildId: m.handoff.grants[0].guildId,
        channelId_timestamp: "another-meeting-in-same-partition",
      },
      ["notes"],
    ),
  ).toBe(true);
  expect(
    permitted({ guildId: "foreign", channelId_timestamp: "approved" }, [
      "notes",
    ]),
  ).toBe(false);
  expect(permitted({ guildId: m.handoff.grants[0].guildId }, ["context"])).toBe(
    false,
  );
  expect(permitted({ guildId: m.handoff.grants[0].guildId }, [])).toBe(false);
});
