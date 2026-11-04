/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { validateArtifactPreservationPlan } from "../../scripts/deployment/validate-artifact-preservation-plan.cjs";
import {
  artifactPreservationAccountId as accountId,
  artifactPreservationPlan,
  grant,
  refreshedBucket,
  transcriptsPolicyAddress,
} from "../fixtures/deployment/artifactPreservationPlan.js";
import {
  dropResource,
  findChange,
  forceUpdate,
  markAllNoOp,
  runPlanGuard,
} from "../fixtures/deployment/planGuard.js";

type Plan = ReturnType<typeof artifactPreservationPlan>;

const guard = "scripts/deployment/validate-artifact-preservation-plan.cjs";
const validate = (plan: Plan, environment = "production") =>
  validateArtifactPreservationPlan(plan, { accountId, environment });
function rejected(mutate: (plan: Plan) => void) {
  const plan = artifactPreservationPlan();
  mutate(plan);
  expect(() => validate(plan)).toThrow();
}

test("accepts the versioned read added to the transcripts policy", () => {
  expect(validate(artifactPreservationPlan()).changes).toEqual([
    { address: transcriptsPolicyAddress, action: "update" },
  ]);
});

test("refuses a Sandbox binding and a malformed account", () => {
  expect(() => validate(artifactPreservationPlan(), "sandbox")).toThrow();
  expect(() =>
    validateArtifactPreservationPlan(artifactPreservationPlan(), {
      accountId: "12345",
      environment: "production",
    }),
  ).toThrow();
});

test("refuses an already applied plan and a missing policy", () => {
  expect(() => validate(markAllNoOp(artifactPreservationPlan()))).toThrow();
  rejected((plan) => dropResource(plan, transcriptsPolicyAddress));
});

test.each([
  ["a wildcard action", grant(["s3:*"])],
  ["a wider service action", grant(["s3:GetObjectVersion", "s3:DeleteObject"])],
  [
    "a different bucket",
    grant(["s3:GetObjectVersion"], ["arn:aws:s3:::other"]),
  ],
  [
    "a second statement",
    JSON.stringify({ Version: "2012-10-17", Statement: [] }),
  ],
])("refuses %s", (_label, policy) => {
  expect(() => validate(artifactPreservationPlan(policy))).toThrow();
});

test("refuses a renamed policy, a deny and a conditioned grant", () => {
  rejected((plan) => {
    findChange(plan, transcriptsPolicyAddress).change.after.name = "other";
  });
  rejected((plan) => {
    const { change } = findChange(plan, transcriptsPolicyAddress);
    const document = JSON.parse(change.after.policy);
    document.Statement[0].Effect = "Deny";
    change.after.policy = JSON.stringify(document);
  });
  rejected((plan) => {
    const { change } = findChange(plan, transcriptsPolicyAddress);
    const document = JSON.parse(change.after.policy);
    document.Statement[0].Condition = {
      Bool: { "aws:SecureTransport": "true" },
    };
    change.after.policy = JSON.stringify(document);
  });
});

// The policy builds its bucket ARN from the bucket name, so a refreshed bucket
// means that decoupling regressed and the scope reaches further than reviewed.
test("refuses any other resource in the targeted graph", () => {
  rejected((plan) => plan.resource_changes.push(refreshedBucket));
  rejected((plan) =>
    forceUpdate(plan, "aws_iam_policy.dynamodb_access_policy"),
  );
});

test("the CLI accepts the reviewed plan and refuses anything else", () => {
  const accepted = runPlanGuard(
    guard,
    JSON.stringify(artifactPreservationPlan()),
    [accountId, "production"],
  );
  expect(accepted.status).toBe(0);
  expect(JSON.parse(accepted.stdout).result).toBe("accepted");
  const refused = runPlanGuard(guard, JSON.stringify({}), [
    accountId,
    "production",
  ]);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("Artifact preservation plan rejected");
});
