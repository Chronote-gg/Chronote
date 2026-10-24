/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect, jest } from "@jest/globals";
import { Readable } from "node:stream";
import * as sdk from "@aws-sdk/client-dynamodb";
import {
  collectPrincipal,
  parseIdentity,
} from "../../scripts/deployment/collector-principal.cjs";
import { buildProbeRequests } from "../../scripts/deployment/maintenance-probe.cjs";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";
const taskId = "d".repeat(32);
const expected = {
  accountId: "123456789012",
  roleArn: "arn:aws:iam::123456789012:role/chronote-app",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/chronote-cluster/" + taskId,
};
const xml =
  '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::123456789012:assumed-role/chronote-app/' +
  taskId +
  "</Arn><UserId>AROAEXAMPLE:" +
  taskId +
  "</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>11111111-1111-4111-8111-111111111111</RequestId></ResponseMetadata></GetCallerIdentityResponse>";
function setup(identity = xml, status = 200) {
  let calls = 0;
  const requests = [];
  const fake = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "synthetic-secret",
    sessionToken: "synthetic-token",
  };
  const requestHandler = {
    destroy() {},
    handle: async (request) => {
      requests.push(request);
      const sts = request.hostname.startsWith("sts.");
      return {
        response: {
          statusCode: sts ? status : 400,
          headers: sts
            ? {}
            : {
                "content-type": "application/x-amz-json-1.0",
                "x-amzn-requestid": "offline-request",
              },
          body: Readable.from([
            sts
              ? identity
              : JSON.stringify({
                  __type: "ConditionalCheckFailedException",
                  message: "synthetic",
                }),
          ]),
        },
      };
    },
  };
  return {
    requests,
    options: {
      sdk,
      version: "3.1149.0",
      region: "us-east-1",
      expected,
      probes: buildProbeRequests(manifestFixture().binding),
      signal: AbortSignal.timeout(5000),
      credentials: async () => {
        calls++;
        return {
          ...fake,
          accessKeyId: calls === 1 ? fake.accessKeyId : "DIFFERENT",
        };
      },
      requestHandler,
    },
    calls: () => calls,
  };
}
test("real installed serializers sign STS and all six exact shapes with one credential snapshot", async () => {
  const f = setup();
  const result = await collectPrincipal(f.options);
  expect(f.calls()).toBe(1);
  expect(f.requests).toHaveLength(7);
  expect(result.identity.accountId).toBe(expected.accountId);
  expect(
    Object.values(result.results).every(
      (r) => r.outcome === "condition_refused",
    ),
  ).toBe(true);
  for (const r of f.requests) {
    expect(r.protocol).toBe("https:");
    expect(r.headers.authorization).toContain("Credential=AKIDEXAMPLE/");
    expect(r.headers["x-amz-security-token"]).toBe("synthetic-token");
  }
  expect(f.requests[0].headers.authorization).toContain("/sts/aws4_request");
  expect(
    f.requests.slice(1).map((r) => JSON.parse(Buffer.from(r.body).toString())),
  ).toEqual(Object.values(f.options.probes).map((p) => p.request));
});
test.each([
  "duplicate",
  "dtd",
  "trailing",
  "role",
  "account",
  "session",
  "oversize",
  "malformed",
  "redirect",
])("rejects %s identity before DynamoDB probes", async (fault) => {
  let body = xml;
  if (fault === "duplicate")
    body = body.replace(
      "</GetCallerIdentityResult>",
      "<Account>123456789012</Account></GetCallerIdentityResult>",
    );
  if (fault === "dtd") body = "<!DOCTYPE x>" + body;
  if (fault === "trailing") body += "x";
  if (fault === "role") body = body.replace("chronote-app", "other");
  if (fault === "account")
    body = body.replace("<Account>123456789012", "<Account>000000000000");
  if (fault === "session") body = body.replace(taskId, "other");
  if (fault === "oversize") body = "x".repeat(17000);
  if (fault === "malformed") body = body.slice(0, -4);
  const f = setup(body, fault === "redirect" ? 302 : 200);
  await expect(collectPrincipal(f.options)).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});
test("version mismatch occurs before credential resolution", async () => {
  const f = setup();
  await expect(
    collectPrincipal({ ...f.options, version: "0" }),
  ).rejects.toThrow();
  expect(f.calls()).toBe(0);
});
test("strict identity rejects unsupported entities and omitted fields", () => {
  expect(() =>
    parseIdentity(xml.replace("<Account>123456789012</Account>", ""), expected),
  ).toThrow();
  expect(() =>
    parseIdentity(xml.replace("AROAEXAMPLE", "AROA&amp;"), expected),
  ).toThrow();
});

test("expired absolute deadline refuses before resolving credentials", async () => {
  const f = setup();
  await expect(
    collectPrincipal({ ...f.options, deadlineMs: Date.now() - 1 }),
  ).rejects.toThrow();
  expect(f.calls()).toBe(0);
  expect(f.requests).toHaveLength(0);
});
test("expiry between probe requests prevents every later submission", async () => {
  const f = setup(),
    started = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(started);
  const handle = f.options.requestHandler.handle;
  f.options.requestHandler.handle = async (request) => {
    const response = await handle(request);
    if (f.requests.length === 2) clock.mockReturnValue(started + 1000);
    return response;
  };
  try {
    await expect(
      collectPrincipal({ ...f.options, deadlineMs: started + 1000 }),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});
