import { getJestConfig } from "@storybook/test-runner";
const config = getJestConfig();
export default {
  ...config,
  rootDir: process.cwd(),
  testMatch: config.testMatch.map((pattern) => pattern.replaceAll("\\", "/")),
  testPathIgnorePatterns: ["/node_modules/"],
};
