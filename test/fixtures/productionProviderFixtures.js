import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";

export function protectedEnvironment(name) {
  const ids = {
    production: 1,
    "production-continuation": 2,
    "production-acceptance": 3,
  };
  return {
    id: ids[name],
    name,
    can_admins_bypass: false,
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", id: 7 }],
      },
    ],
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false,
    },
  };
}
export function s3Transport(send, settings) {
  return { send: (command) => send(command, settings) };
}
export function protectedPolicy(name, branches) {
  const environment = protectedEnvironment(name);
  return {
    environmentId: environment.id,
    environmentHash: canonicalHash(environment),
    branchPolicyHash: canonicalHash(branches),
    reviewerIds: ["7"],
  };
}
