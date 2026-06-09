import type { Config } from "@jest/types";

const config: Config.InitialOptions = {
  collectCoverage: true,
  collectCoverageFrom: [
    "src/api/desktop.ts",
    "src/services/desktopAuthService.ts",
    "src/repositories/desktopAuthRepository.ts",
    "src/types/desktopAuth.ts",
  ],
  coverageDirectory: "coverage/desktop",
  coverageProvider: "v8",
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 60,
      functions: 65,
      lines: 75,
    },
  },
  preset: "ts-jest",
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    customExportConditions: ["node", "node-addons"],
  },
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "identity-obj-proxy",
    "\\.(jpg|jpeg|png|gif|svg)$": "<rootDir>/test/__mocks__/fileMock.js",
    "^react-markdown$": "<rootDir>/test/__mocks__/reactMarkdown.tsx",
    "^remark-gfm$": "<rootDir>/test/__mocks__/remarkGfm.ts",
    "^react-quill-new$": "<rootDir>/test/__mocks__/reactQuillNew.tsx",
    "^uuid$": "<rootDir>/test/__mocks__/uuid.ts",
  },
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
    "^.+\\.(js|jsx|mjs)$": "babel-jest",
  },
  transformIgnorePatterns: ["node_modules/"],
  testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[tj]s?(x)"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/build/", "/test/e2e/"],
  moduleFileExtensions: ["js", "jsx", "ts", "tsx", "json", "node", "mjs"],
  setupFilesAfterEnv: ["<rootDir>/src/setupTests.ts"],
};

export default config;
