/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { assertProductionIdentity } from "../../scripts/deployment/assert-production-identity.cjs";

const account = "123456789012";
const deploy = `arn:aws:iam::${account}:role/meeting-notes-prod-github-deploy`;
const guard = `arn:aws:iam::${account}:role/meeting-notes-prod-prompt-guard`;
function check(role, session, actor = {}) {
  return () =>
    assertProductionIdentity(
      {
        Account: account,
        Arn: `arn:aws:sts::${account}:assumed-role/${role.split("/").at(-1)}/${session}`,
        ...actor,
      },
      {
        EXPECTED_ACCOUNT_ID: account,
        EXPECTED_ROLE_ARN: role,
        EXPECTED_SESSION_NAME: session,
      },
    );
}

test.each([
  [deploy, "chronote-production-40817317099-1"],
  [guard, "prompt-40817317099-2"],
])("accepts %s with session %s", (role, session) => {
  expect(check(role, session)).not.toThrow();
});

test.each([
  ["deploy role with a prompt session", deploy, "prompt-1-1"],
  ["guard role with a deploy session", guard, "chronote-production-1-1"],
  ["a zero run id", guard, "prompt-0-1"],
  ["a suffixed session", guard, "prompt-1-1-extra"],
  [
    "another role",
    `arn:aws:iam::${account}:role/meeting-notes-prod-introduction`,
    "prompt-1-1",
  ],
  [
    "a Sandbox guard role",
    `arn:aws:iam::${account}:role/meeting-notes-sandbox-prompt-guard`,
    "prompt-1-1",
  ],
  [
    "a rehearsal deploy role",
    `arn:aws:iam::${account}:role/rehearsal-github-deploy`,
    "chronote-production-1-1",
  ],
  [
    "a foreign account role",
    "arn:aws:iam::999999999999:role/meeting-notes-prod-prompt-guard",
    "prompt-1-1",
  ],
])("refuses %s", (_name, role, session) => {
  expect(check(role, session)).toThrow();
});

test.each([
  ["a foreign caller account", { Account: "999999999999" }],
  [
    "a different assumed session",
    {
      Arn: `arn:aws:sts::${account}:assumed-role/meeting-notes-prod-prompt-guard/prompt-9-9`,
    },
  ],
])("refuses a guard caller with %s", (_name, actor) => {
  expect(check(guard, "prompt-1-1", actor)).toThrow();
});
