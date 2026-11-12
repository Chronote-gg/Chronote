import { config } from "../../src/services/configService";
import type { RuntimeIdentity } from "../../src/types/deploymentControl";

/** The runtime that admits receipts in these tests. */
export const receiptRuntime: RuntimeIdentity = {
  kind: "ecs",
  instanceId: "old",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/fixture/old",
  imageDigest: "sha256:fixture",
  candidateId: "old",
  protocolVersion: 1,
};

/** The admission a receipt records when that runtime admits it under lease "token". */
export const expectedAdmission = (attemptId: string) => ({
  attemptId,
  leaseToken: "token",
  runtime: receiptRuntime,
  generation: config.runtime.release,
  admittedAt: expect.any(Number),
});
