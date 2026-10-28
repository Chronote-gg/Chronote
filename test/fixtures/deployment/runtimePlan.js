// Synthetic `terraform show -json` shape for the deployment-runtime scope.
const managed = (address, actions, change = {}) => ({
  address,
  mode: "managed",
  change: { actions, ...change },
});
const guildTableBefore = {
  name: "meeting-notes-prod-GuildSubscriptionTable",
  hash_key: "guildId",
  attribute: [{ name: "guildId", type: "S" }],
  global_secondary_index: [],
  point_in_time_recovery: [{ enabled: true }],
  tags_all: { Name: "GuildSubscriptionTable" },
};
const targetGroupBefore = {
  name: "meeting-notes-prod-api-tg",
  deregistration_delay: "300",
  health_check: [{ path: "/health" }],
  tags_all: { Project: "meeting-notes" },
};

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
      managed("aws_iam_role.production_deploy[0]", ["create"]),
      managed("aws_iam_role_policy.production_deploy[0]", ["create"]),
      managed("aws_iam_role_policy_attachment.production_deploy_routing[0]", [
        "create",
      ]),
      managed("aws_iam_policy.site_publishing[0]", ["create"]),
      managed("aws_iam_role_policy_attachment.site_publishing[0]", ["create"]),
      managed("aws_iam_role_policy.production_exec_channels[0]", ["create"]),
      managed("aws_iam_policy.dynamodb_access_policy", ["update"]),
      managed('aws_iam_role.production_introduction["prompt-guard"]', [
        "create",
      ]),
      managed("aws_iam_role_policy.production_prompt_guard[0]", ["create"]),
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
        },
        after_unknown: {
          attribute: [{}, {}, {}],
          global_secondary_index: [{ warm_throughput: true }],
          point_in_time_recovery: [{}],
          tags_all: {},
        },
      }),
      managed("aws_lb_target_group.api_tg[0]", ["update"], {
        before: structuredClone(targetGroupBefore),
        after: {
          ...structuredClone(targetGroupBefore),
          deregistration_delay: "30",
        },
        after_unknown: { health_check: [{}], tags_all: {} },
      }),
    ],
  };
}
