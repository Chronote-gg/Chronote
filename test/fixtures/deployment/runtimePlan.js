// Synthetic `terraform show -json` shape for the deployment-runtime scope.
export const runtimeAccountId = "123456789012";
const managed = (address, actions, change = {}) => ({
  address,
  mode: "managed",
  change: { actions, ...change },
});
const document = (...Statement) =>
  JSON.stringify({ Version: "2012-10-17", Statement });
export const githubTrust = () =>
  document({
    Effect: "Allow",
    Principal: {
      Federated: `arn:aws:iam::${runtimeAccountId}:oidc-provider/token.actions.githubusercontent.com`,
    },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub":
          "repo:Chronote-gg/Chronote:environment:production",
      },
    },
  });
const scopedPolicy = () =>
  document(
    {
      Effect: "Allow",
      Action: ["ecs:UpdateService"],
      Resource: `arn:aws:ecs:us-east-1:${runtimeAccountId}:service/cluster/service`,
    },
    {
      Effect: "Allow",
      Action: ["ecs:ListTasks", "ecr:GetAuthorizationToken"],
      Resource: "*",
    },
  );
const guildTableBefore = {
  name: "meeting-notes-prod-GuildSubscriptionTable",
  hash_key: "guildId",
  attribute: [{ name: "guildId", type: "S" }],
  global_secondary_index: [],
  point_in_time_recovery: [{ enabled: true }],
  stream_arn: "",
  stream_label: "",
  tags_all: { Name: "GuildSubscriptionTable" },
};
const targetGroupBefore = {
  name: "meeting-notes-prod-api-tg",
  deregistration_delay: "300",
  health_check: [{ path: "/health" }],
  tags_all: { Project: "meeting-notes" },
};
const withDocument = (address, actions, key, value) =>
  managed(address, actions, { after: { [key]: value } });

export function runtimePlan() {
  return {
    resource_changes: [
      managed("aws_kms_key.app_general", ["no-op"]),
      managed("aws_lb_listener.api_https[0]", ["no-op"]),
      managed("aws_ecs_cluster.main", ["no-op"]),
      {
        address: "data.aws_caller_identity.current",
        mode: "data",
        change: { actions: ["read"] },
      },
      withDocument(
        "aws_iam_role.production_deploy[0]",
        ["create"],
        "assume_role_policy",
        githubTrust(),
      ),
      ...[
        ["aws_iam_role_policy.production_deploy[0]", "create"],
        ["aws_iam_policy.site_publishing[0]", "create"],
        ["aws_iam_role_policy.production_exec_channels[0]", "create"],
        ["aws_iam_policy.dynamodb_access_policy", "update"],
        ["aws_iam_role_policy.production_prompt_guard[0]", "create"],
      ].map(([address, action]) =>
        withDocument(address, [action], "policy", scopedPolicy()),
      ),
      managed("aws_iam_role_policy_attachment.production_deploy_routing[0]", [
        "create",
      ]),
      managed("aws_iam_role_policy_attachment.site_publishing[0]", ["create"]),
      withDocument(
        'aws_iam_role.production_introduction["prompt-guard"]',
        ["create"],
        "assume_role_policy",
        githubTrust(),
      ),
      managed("aws_dynamodb_table.guild_subscription_table", ["update"], {
        before: structuredClone(guildTableBefore),
        after: {
          ...structuredClone(guildTableBefore),
          attribute: [
            { name: "recoveryQueue", type: "S" },
            { name: "guildId", type: "S" },
            { name: "recoveryDueAt", type: "N" },
          ],
          global_secondary_index: [
            {
              name: "RenewalRecoveryDueIndex",
              hash_key: "recoveryQueue",
              range_key: "recoveryDueAt",
              projection_type: "KEYS_ONLY",
              non_key_attributes: [],
            },
          ],
          stream_arn: null,
          stream_label: null,
        },
        // The provider recomputes the stream outputs on an in-place update.
        after_unknown: {
          attribute: [{}, {}, {}],
          global_secondary_index: [{ warm_throughput: true }],
          point_in_time_recovery: [{}],
          stream_arn: true,
          stream_label: true,
          tags_all: {},
        },
      }),
      ...["api_tg", "api_spare_tg"].map((name) =>
        managed(`aws_lb_target_group.${name}[0]`, ["update"], {
          before: { ...structuredClone(targetGroupBefore), name },
          after: {
            ...structuredClone(targetGroupBefore),
            name,
            deregistration_delay: "5",
          },
          after_unknown: { health_check: [{}], tags_all: {} },
        }),
      ),
    ],
  };
}
