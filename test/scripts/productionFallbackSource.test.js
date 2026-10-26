/** @jest-environment node */
import { jest, test, expect, beforeEach } from "@jest/globals";
import { createHash } from "node:crypto";
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

test.each(["deploy.yml", "terraform-apply.yml"])(
  "actual reviewed %s source with bound hashes refuses its unaccounted static credential route",
  (workflow) => {
    const actual = binding();
    const read = (file, encoding) =>
      String(file).endsWith(workflow)
        ? readActualSource(file, encoding)
        : readOidcOnlySource(file, encoding);
    actual.manifest.launcherRoutes = reviewedRoutes(actual.manifest, read);
    mockFile.mockImplementation(read);
    expect(() => verifyDeclaredRoutes(actual)).toThrow(
      "unaccounted_static_credential_route",
    );
  },
);

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
