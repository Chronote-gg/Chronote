import { REQUIRED_CHECKS } from "../../../scripts/deployment/break-glass-checks.cjs";

export const mergeSha = "c".repeat(40);
export const headSha = "e".repeat(40);
/** GitHub's default variables plus the inputs deploy.yml maps for a break-glass dispatch. */
export const dispatchEnv = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/master",
  GITHUB_ACTOR: "BASIC-BIT",
  GITHUB_TRIGGERING_ACTOR: "BASIC-BIT",
  GITHUB_RUN_ID: "41521247472",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: mergeSha,
  BREAK_GLASS_REASON: "voice leave fix",
  BREAK_GLASS_MANIFEST_SHA256: "d".repeat(64),
};
export type CheckContext = Record<string, unknown>;
export function checkRun(
  name: string,
  {
    conclusion = "SUCCESS",
    status = "COMPLETED",
    databaseId = 1,
    workflow = "CI",
    app = "github-actions",
  } = {},
): CheckContext {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    databaseId,
    checkSuite: {
      app: { slug: app },
      workflowRun: { workflow: { name: workflow } },
    },
  };
}
export const greenChecks = () =>
  REQUIRED_CHECKS.map(({ name, workflow }) => checkRun(name, { workflow }));
/** The `repository.object` of the gate's GraphQL answer for one merged pull request. */
export function mergedCommit(
  contexts: CheckContext[] = greenChecks(),
  pr: Record<string, unknown> = {},
) {
  return {
    associatedPullRequests: {
      nodes: [
        {
          number: 567,
          merged: true,
          baseRefName: "master",
          headRefOid: headSha,
          mergeCommit: { oid: mergeSha },
          commits: {
            nodes: [
              {
                commit: {
                  oid: headSha,
                  statusCheckRollup: {
                    contexts: { totalCount: contexts.length, nodes: contexts },
                  },
                },
              },
            ],
          },
          ...pr,
        },
      ],
    },
  };
}
