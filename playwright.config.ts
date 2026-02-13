import { defineConfig, devices } from "@playwright/test";

const reuseServer = process.env.PW_REUSE_SERVER === "true";
const baseUrl = "http://127.0.0.1:5173";
const mockEnv = {
  MOCK_MODE: "true",
  ENABLE_OAUTH: "false",
  FRONTEND_SITE_URL: baseUrl,
  OPENAI_API_KEY: "test-openai-api-key",
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_CLIENT_ID: "test-client-id",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_CALLBACK_URL: "http://localhost:3001/auth/discord/callback",
  OAUTH_SECRET: "test-oauth-secret",
  FORCE_TIER: "pro",
  MOCK_FIXED_NOW: "2025-01-01T00:00:00.000Z",
  VITE_MOCK_FIXED_NOW: "2025-01-01T00:00:00.000Z",
  VITE_VISUAL_MODE: "0",
  SUPER_ADMIN_USER_IDS: "211750261922725888",
};

for (const [key, value] of Object.entries(mockEnv)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: baseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "yarn start:mock:once",
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: reuseServer,
      env: mockEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
    {
      command: "yarn frontend:dev --host 127.0.0.1 --port 5173",
      url: baseUrl,
      reuseExistingServer: reuseServer,
      env: {
        ...mockEnv,
        // Use Vite's proxy for local E2E to avoid CORS issues.
        VITE_API_BASE_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
