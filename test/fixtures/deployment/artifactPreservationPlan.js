// Synthetic `terraform show -json` shape for the artifact-preservation scope:
// the delivered task-role transcripts policy gaining the versioned object read.
export const artifactPreservationAccountId = "123456789012";
export const transcriptsPolicyAddress = "aws_iam_policy.transcripts_s3_policy";
const bucket = `arn:aws:s3:::meeting-notes-prod-transcripts-${artifactPreservationAccountId}`;
const delivered = [
  "s3:PutObject",
  "s3:GetObject",
  "s3:AbortMultipartUpload",
  "s3:ListBucket",
];

export const grant = (actions, resource = [bucket, `${bucket}/*`]) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: actions, Resource: resource }],
  });

const policyState = (policy) => ({
  name: "meeting-notes-prod-bot-transcripts-s3-policy",
  path: "/",
  policy,
});

export const artifactPreservationPlan = (
  after = grant([...delivered, "s3:GetObjectVersion"]),
) => ({
  resource_changes: [
    {
      address: transcriptsPolicyAddress,
      mode: "managed",
      change: {
        actions: ["update"],
        before: policyState(grant(delivered)),
        after: policyState(after),
        after_unknown: {},
      },
    },
    {
      address: "data.aws_caller_identity.current",
      mode: "data",
      change: { actions: ["read"] },
    },
  ],
});

// The bucket must stay out of the targeted graph; the policy builds its ARN
// from the bucket name instead of referencing the bucket resource.
export const refreshedBucket = {
  address: "aws_s3_bucket.transcripts",
  mode: "managed",
  change: { actions: ["no-op"] },
};
