/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";
import {
  renderCollector,
  collectorTemplateSha256,
  captureNamespace,
} from "../../scripts/deployment/collector-command.cjs";
import { parseProductionManifest } from "../../scripts/deployment/staged-production-manifest.cjs";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";

test("fresh nonces change concrete commands but preserve the reviewed template", () => {
  const m = manifestFixture();
  const base = { nonce: "1", taskArn: m.legacyTaskArn };
  const a = renderCollector(m, base),
    b = renderCollector(m, { ...base, nonce: "2" });
  expect(a.request.commandTemplateSha256).toBe(collectorTemplateSha256());
  expect(a.request.commandTemplateSha256).toBe(b.request.commandTemplateSha256);
  expect(a.request.commandSha256).not.toBe(b.request.commandSha256);
  expect(a.request.inputSha256).not.toBe(b.request.inputSha256);
  expect(renderCollector(m, base)).toEqual(a);
  expect(JSON.parse(a.input)).not.toHaveProperty("commandSha256");
  expect(JSON.parse(a.input)).not.toHaveProperty("inputSha256");
});
test("old ambiguous manifest field is rejected rather than reinterpreted", () => {
  const m = manifestFixture();
  m.collectorCommandSha256 = m.collectorCommandTemplateSha256;
  delete m.collectorCommandTemplateSha256;
  expect(() => parseProductionManifest(m, manifestHash(m))).toThrow();
});
test("capture namespace is selected by strict kind", () => {
  const m = manifestFixture();
  expect(captureNamespace(m, "a".repeat(64))).toMatch(
    /^production-introduction\//,
  );
  expect(
    captureNamespace({ ...m, kind: "rehearsal-introduction" }, "a".repeat(64)),
  ).toMatch(/^rehearsal-introduction\//);
  expect(() =>
    captureNamespace({ ...m, kind: "arbitrary" }, "a".repeat(64)),
  ).toThrow();
});
