/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { createHash } from "node:crypto";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import {
  frozenFixtureDefinitions,
  fixtureInputBinding,
  assertFrozenFixtureChecklist,
} from "../../scripts/deployment/production-fixture-definitions.cjs";
test("both fixed scripts and checklists bind exact bytes without accepting replacements", () => {
  const definitions = frozenFixtureDefinitions();
  const grants = definitions.fixtures.map((item) =>
    fixtureInputBinding(item.role),
  );
  expect(() => assertFrozenFixtureChecklist(definitions, grants)).not.toThrow();
  expect(grants.map((item) => item.scriptSha256)).toEqual([
    "ae68acb71b13af2393833225106361be91d1c51dc7a7848ef62e648ae22f5697",
    "e39093367cd55b6d7ddd135a69a85d7453a87e8d2ec8ff3ea59c8b51505c091a",
  ]);
  const changed = structuredClone(definitions);
  changed.fixtures[0].script += " Invented release.";
  const forged = [...grants];
  forged[0] = {
    ...forged[0],
    scriptSha256: createHash("sha256")
      .update(changed.fixtures[0].script)
      .digest("hex"),
  };
  expect(() => assertFrozenFixtureChecklist(changed, forged)).toThrow();
  const checklist = structuredClone(definitions);
  checklist.fixtures[1].checklist[0].expected = "Invented fact";
  expect(() =>
    assertFrozenFixtureChecklist(checklist, [
      { ...grants[0] },
      {
        ...grants[1],
        checklistSha256: canonicalHash(checklist.fixtures[1].checklist),
      },
    ]),
  ).toThrow();
});
test.each(["role", "missing", "extra", "digest"])(
  "refuses %s fixture definitions",
  (kind) => {
    const definitions = frozenFixtureDefinitions();
    const grants = definitions.fixtures.map((item) =>
      fixtureInputBinding(item.role),
    );
    if (kind === "role") definitions.fixtures[1].role = "across_handoff";
    if (kind === "missing") definitions.fixtures.pop();
    if (kind === "extra") definitions.audioPlayer = "unapproved";
    if (kind === "digest") grants[0].checklistSha256 = "0".repeat(64);
    expect(() => assertFrozenFixtureChecklist(definitions, grants)).toThrow();
  },
);
