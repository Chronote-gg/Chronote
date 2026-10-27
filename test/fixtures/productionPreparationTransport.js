import { jest } from "@jest/globals";
export const mockPreparationAws = jest.fn();
export const mockPreparationS3 = jest.fn();

jest.mock("../../scripts/deployment/coordinator-aws.cjs", () => ({
  awsCli: (...args) => mockPreparationAws(...args),
}));
jest.mock("@aws-sdk/client-s3", () =>
  jest
    .requireActual("./productionSdkMock.js")
    .singleAttemptS3ModuleMock((...args) => mockPreparationS3(...args)),
);
