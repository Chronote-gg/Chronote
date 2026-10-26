import type { Config } from "@jest/types";

const endpoint = process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT;
if (!endpoint) throw new Error("DEPLOYMENT_TEST_DYNAMODB_ENDPOINT is required");
const url = new URL(endpoint);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.protocol !== "http:" ||
  url.username ||
  url.password
)
  throw new Error(
    "Deployment integration tests require an explicit loopback HTTP endpoint",
  );

// Never inherit real credentials, even when the host has an AWS profile.
process.env.AWS_ACCESS_KEY_ID = "dummy";
process.env.AWS_SECRET_ACCESS_KEY = "dummy";
delete process.env.AWS_SESSION_TOKEN;
process.env.AWS_REGION = "local";

const config: Config.InitialOptions = {
  preset: "ts-jest",
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
    "^.+\\.(js|jsx|mjs)$": "babel-jest",
  },
  transformIgnorePatterns: ["node_modules/(?!cockatiel/)"],
  testEnvironment: "node",
  setupFiles: ["<rootDir>/test/deployment/integrationSetup.ts"],
  testMatch: ["**/test/deployment/**/*.integration.test.ts"],
  testTimeout: 180000,
  collectCoverage: false,
};
export default config;
