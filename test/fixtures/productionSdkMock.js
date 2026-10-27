export function singleAttemptS3ClientMock(send) {
  return {
    config: { maxAttempts: async () => 1, region: async () => "us-east-1" },
    send: (...args) => send(...args),
  };
}
import { jest } from "@jest/globals";
export function singleAttemptS3ModuleMock(send) {
  return {
    ...jest.requireActual("@aws-sdk/client-s3"),
    S3Client: jest.fn(() => singleAttemptS3ClientMock(send)),
  };
}
