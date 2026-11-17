/** @jest-environment node */
import { spawnSync } from "node:child_process";
import path from "node:path";
const source = path.resolve("src/services/configService.ts");
function load(role: string, extra: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(MOCK_MODE|DISCORD_|ENABLE_OAUTH|ENABLE_MCP|OPENAI_|SESSION_SECRET|OAUTH_SECRET|FRONTEND_SITE_URL|SEARCH_|LANGFUSE_)/.test(
        key,
      )
    )
      delete env[key];
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      `require(${JSON.stringify(source)})`,
    ],
    { encoding: "utf8", env: { ...env, RUNTIME_ROLE: role, ...extra } },
  );
}
const valid = {
  SEARCH_GENERATION: "v1",
  SEARCH_MEETING_INDEX_ARN: "meeting-index",
  SEARCH_TRANSCRIPT_INDEX_ARN: "transcript-index",
  SEARCH_STATE_TABLE_NAME: "state",
  SEARCH_HISTORY_TABLE_NAME: "history",
  OPENAI_API_KEY_SECRET_ARN: "secret",
  TRANSCRIPTS_BUCKET: "fixture-bucket",
};
test("projection bootstrap accepts only its own resources and embedding secret, without Discord credentials", () => {
  const result = load("search-projection", valid);
  expect(result.stderr).not.toContain("Missing required");
  expect(result.status).toBe(0);
});
test("projection bootstrap rejects missing embedding credentials", () => {
  const result = load("search-projection", {
    ...valid,
    OPENAI_API_KEY_SECRET_ARN: "",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "OPENAI_API_KEY or OPENAI_API_KEY_SECRET_ARN",
  );
});
test("serving roles still require Discord and session credentials", () => {
  const result = load("api", valid);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("DISCORD_BOT_TOKEN");
});
