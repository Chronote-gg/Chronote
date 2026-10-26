/** @jest-environment node */
import { expect, test } from "@jest/globals";
import * as definitions from "../../scripts/deployment/task-definition.cjs";
import { bindingHash } from "../../scripts/deployment/binding-hash.cjs";

const prepared = {
  family: "sandbox",
  containerDefinitions: [
    {
      name: "bot",
      image: "image@sha256:approved",
      stopTimeout: 120,
      command: ["node", "dist/index.js"],
      environment: [
        { name: "A", value: "1" },
        { name: "B", value: "2" },
      ],
      secrets: [{ name: "KEY", valueFrom: "approved" }],
    },
  ],
};
function verify(actual, expected = prepared, hash = bindingHash(expected)) {
  definitions.assertPreparedTaskDefinition(actual, expected, hash);
}
test("only unique-name environment ordering may differ, without mutating either input", () => {
  const actual = structuredClone(prepared);
  actual.containerDefinitions[0].environment.reverse();
  const before = structuredClone(actual);
  expect(() => verify(actual)).not.toThrow();
  expect(actual).toEqual(before);
  expect(prepared.containerDefinitions[0].environment[0].name).toBe("A");
});
test.each([
  "value",
  "image",
  "stopTimeout",
  "command",
  "secrets",
  "entryShape",
  "duplicateActual",
  "duplicatePrepared",
  "rawHash",
])("refuses material drift: %s", (scenario) => {
  const expected = structuredClone(prepared),
    actual = structuredClone(prepared);
  const c = actual.containerDefinitions[0];
  if (scenario === "value") c.environment[0].value = "changed";
  if (scenario === "image") c.image = "wrong";
  if (scenario === "stopTimeout") c.stopTimeout = 30;
  if (scenario === "command") c.command.reverse();
  if (scenario === "secrets") c.secrets[0].valueFrom = "wrong";
  if (scenario === "entryShape") c.environment[0].extra = true;
  if (scenario === "duplicateActual") c.environment.push(c.environment[0]);
  if (scenario === "duplicatePrepared")
    expected.containerDefinitions[0].environment.push(
      expected.containerDefinitions[0].environment[0],
    );
  expect(() =>
    verify(
      actual,
      expected,
      scenario === "rawHash" ? "0".repeat(64) : bindingHash(expected),
    ),
  ).toThrow();
});
