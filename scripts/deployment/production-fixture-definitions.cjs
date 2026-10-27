"use strict";
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { z } = require("zod");
const definition = z
  .object({
    role: z.enum(["across_handoff", "after_handoff"]),
    script: z.string().min(1),
    checklist: z
      .array(
        z
          .object({
            category: z.enum([
              "fact",
              "decision",
              "action",
              "attribution",
              "omission",
              "invention",
            ]),
            expected: z.string().min(1),
          })
          .strict(),
      )
      .min(6)
      .max(10),
  })
  .strict();
const definitionsSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtures: z.tuple([definition, definition]),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, fixture] of value.fixtures.entries()) {
      const words = fixture.script.trim().split(/\s+/).length;
      const [role, minimum, maximum] =
        index === 0
          ? ["across_handoff", 500, 600]
          : ["after_handoff", 100, 140];
      if (
        fixture.role !== role ||
        words < minimum ||
        words > maximum ||
        new Set(fixture.checklist.map((item) => item.category)).size !== 6
      )
        ctx.addIssue({
          code: "custom",
          message: "Frozen fixture role, script or checklist is invalid",
        });
    }
  });
function frozenFixtureDefinitions() {
  return definitionsSchema.parse(
    require("./production-fixture-definitions.json"),
  );
}
function fixtureInputBinding(role) {
  const fixture = frozenFixtureDefinitions().fixtures.find(
    (item) => item.role === role,
  );
  if (!fixture) throw new Error("Unknown frozen fixture role");
  return {
    inputProfile: "manual_script_v1",
    scriptSha256: createHash("sha256")
      .update(fixture.script, "utf8")
      .digest("hex"),
    checklistSha256: require("./production-manifest.cjs").canonicalHash(
      fixture.checklist,
    ),
  };
}
function assertFrozenFixtureChecklist(value, grants) {
  if (
    !isDeepStrictEqual(
      definitionsSchema.parse(value),
      frozenFixtureDefinitions(),
    )
  )
    throw new Error("Frozen fixture definition mismatch");
  assertFrozenFixtureBindings(grants);
}
function assertFrozenFixtureBindings(grants) {
  for (const [index, role] of ["across_handoff", "after_handoff"].entries()) {
    for (const [key, expected] of Object.entries(fixtureInputBinding(role)))
      if (grants[index]?.[key] !== expected)
        throw new Error("Frozen fixture grant mismatch");
  }
}
module.exports = {
  frozenFixtureDefinitions,
  fixtureInputBinding,
  assertFrozenFixtureChecklist,
  assertFrozenFixtureBindings,
};
