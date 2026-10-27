/** @jest-environment node */
import { jest, test, expect, beforeEach } from "@jest/globals";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  reviewedRoutes,
  readActualSource,
  readOidcOnlySource,
} from "../fixtures/productionReviewedSource.js";
import {
  verifyDeclaredRoutes,
  readVerifiedFallbackTemplates,
  declaredRoutesVerified,
} from "../../scripts/deployment/production-source-routes.cjs";
const mockGit = jest.fn(),
  mockFile = jest.fn();
jest.mock("node:child_process", () => ({
  execFileSync: (...args) => mockGit(...args),
}));
jest.mock("node:fs", () => ({ readFileSync: (...args) => mockFile(...args) }));
const commit = "a".repeat(40),
  scope = "b".repeat(64),
  template = "reviewed source template bytes",
  route = "jobs: { reviewed: { steps: [] } }";
const path = "src/services/transcriptionPromptService.ts";
function binding() {
  return {
    manifestHash: scope,
    manifest: {
      identity: { sourceCommit: commit },
      launcherRoutes: reviewedRoutes(
        { identity: { sourceCommit: commit } },
        (file, encoding) =>
          file.endsWith("production-introduction.yml")
            ? readActualSource(file, encoding)
            : route,
      ),
    },
  };
}
beforeEach(() => {
  mockGit
    .mockReset()
    .mockImplementation((_command, args) =>
      args[0] === "rev-parse" ? commit : "",
    );
  mockFile
    .mockReset()
    .mockImplementation((file) =>
      file.replaceAll("\\", "/").endsWith(path)
        ? template
        : String(file).includes("production-introduction.yml") ||
            String(file).includes("production-workflow.cjs")
          ? readActualSource(file, "utf8")
          : route,
    );
});
test("fallback template identity comes from the authenticated clean source receipt", () => {
  const token = verifyDeclaredRoutes(binding());
  expect(declaredRoutesVerified(token, scope)).toBe(true);
  expect(readVerifiedFallbackTemplates(token, scope, [path])).toEqual([
    {
      sourceCommit: commit,
      path,
      sourceSha256: createHash("sha256").update(template).digest("hex"),
    },
  ]);
  for (const copy of [{}, { ...token }, JSON.parse(JSON.stringify(token))])
    expect(() => readVerifiedFallbackTemplates(copy, scope, [path])).toThrow();
  expect(() =>
    readVerifiedFallbackTemplates(token, "c".repeat(64), [path]),
  ).toThrow();
  expect(() =>
    readVerifiedFallbackTemplates(token, scope, ["other-template"]),
  ).toThrow();
});
test("wrong source, dirty source and unavailable template never bind a fallback", () => {
  mockGit.mockReturnValue("wrong-source");
  expect(() => verifyDeclaredRoutes(binding())).toThrow();
  mockGit.mockImplementation((_command, args) => {
    if (args[0] === "diff") throw Error("dirty");
    return commit;
  });
  expect(() => verifyDeclaredRoutes(binding())).toThrow();
  mockGit.mockImplementation((_command, args) =>
    args[0] === "rev-parse" ? commit : "",
  );
  mockFile.mockImplementation((file) => {
    if (file.replaceAll("\\", "/").endsWith(path))
      throw Error("missing-template");
    return route;
  });
  expect(() => verifyDeclaredRoutes(binding())).toThrow();
});

function reviewedWorkflowBinding(workflow, contents) {
  const actual = binding();
  const read = (file, encoding) =>
    String(file).endsWith(workflow)
      ? contents
      : readOidcOnlySource(file, encoding);
  actual.manifest.launcherRoutes = reviewedRoutes(actual.manifest, read);
  mockFile.mockImplementation(read);
  return actual;
}
const applyPath = ".github/workflows/terraform-apply.yml";
test("actual reviewed deploy source with bound hashes refuses its unaccounted static credential route", () => {
  const contents = readActualSource(".github/workflows/deploy.yml", "utf8");
  expect(() =>
    verifyDeclaredRoutes(reviewedWorkflowBinding("deploy.yml", contents)),
  ).toThrow("unaccounted_static_credential_route");
});
test("actual reviewed Apply source accounts for its Sandbox and production role-only routes", () => {
  const contents = readActualSource(applyPath, "utf8");
  const credentials = parse(contents).jobs.apply.steps.filter((step) =>
    step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  expect(credentials.map((step) => step.with["role-to-assume"])).toEqual([
    "${{ vars.TERRAFORM_AWS_ROLE_ARN }}",
    "${{ vars.PRODUCTION_APPLY_ROLE_ARN }}",
  ]);
  expect(
    declaredRoutesVerified(
      verifyDeclaredRoutes(
        reviewedWorkflowBinding("terraform-apply.yml", contents),
      ),
      scope,
    ),
  ).toBe(true);
});
const credentialNames = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];
const staticAcquisitions = [
  ...["aws-access-key-id", "aws-secret-access-key", "aws-session-token"].map(
    (name) => [
      name,
      {
        uses: "aws-actions/configure-aws-credentials@v6",
        with: { [name]: "SYNTHETIC_UNACCOUNTED" },
      },
    ],
  ),
  ...credentialNames.map((name) => [
    name,
    { run: "true", env: { [name]: "SYNTHETIC_UNACCOUNTED" } },
  ]),
  ...["secrets", "vars"].flatMap((namespace) =>
    credentialNames.map((name) => [
      namespace + "." + name,
      { run: "echo ${{ " + namespace + "." + name + " }}" },
    ]),
  ),
];
test.each(staticAcquisitions)(
  "Apply source refuses reintroduced %s acquisition even with matching reviewed hashes",
  (_name, step) => {
    const workflow = parse(readActualSource(applyPath, "utf8"));
    workflow.jobs.apply.steps.push(step);
    const actual = reviewedWorkflowBinding(
      "terraform-apply.yml",
      stringify(workflow),
    );
    expect(() => verifyDeclaredRoutes(actual)).toThrow(
      "unaccounted_static_credential_route",
    );
  },
);
test("Plan has no static credentials and accounting still refuses a reintroduced legacy route", () => {
  const contents = readActualSource(
    ".github/workflows/terraform-plan.yml",
    "utf8",
  );
  const workflow = parse(contents);
  expect(
    workflow.jobs.plan.steps.filter((step) => step.with?.["aws-access-key-id"]),
  ).toHaveLength(0);
  workflow.jobs.plan.steps.push(staticAcquisitions[0][1]);
  // Plan is not in the launcher inventory; supply its actual body through a declared workflow transport.
  const actual = reviewedWorkflowBinding(
    "terraform-apply.yml",
    stringify(workflow),
  );
  expect(() => verifyDeclaredRoutes(actual)).toThrow(
    "unaccounted_static_credential_route",
  );
});

test("OIDC-exported credential consumption is not static credential acquisition", () => {
  const actual = binding();
  const read = (file, encoding) =>
    String(file).endsWith("deploy.yml")
      ? 'jobs: { reviewed: { steps: [{ uses: "aws-actions/configure-aws-credentials@v6", with: { role-to-assume: "${{ vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN }}" } }, { run: "echo $AWS_ACCESS_KEY_ID" }] } }'
      : readOidcOnlySource(file, encoding);
  actual.manifest.launcherRoutes = reviewedRoutes(actual.manifest, read);
  mockFile.mockImplementation(read);
  expect(declaredRoutesVerified(verifyDeclaredRoutes(actual), scope)).toBe(
    true,
  );
});

test("staged source cannot silently replace its session limit or unavailable-authority refusal", () => {
  for (const target of [
    "production-introduction.yml",
    "production-workflow.cjs",
  ]) {
    const actual = binding();
    const read = (file, encoding) => {
      const content = readOidcOnlySource(file, encoding);
      if (!String(file).endsWith(target)) return content;
      return target.endsWith(".yml")
        ? content.replace('"ecs:DescribeTasks"', '"ecs:UpdateService"')
        : content.replace(
            'throw new Error("Post-bind human authority unavailable; preserve state")',
            "return {}",
          );
    };
    actual.manifest.launcherRoutes = reviewedRoutes(actual.manifest, read);
    mockFile.mockImplementation(read);
    expect(() => verifyDeclaredRoutes(actual)).toThrow(
      "staged_source_prerequisite",
    );
  }
});
