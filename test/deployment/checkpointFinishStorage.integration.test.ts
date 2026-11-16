import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { history } from "../fixtures/meetingHistory";
import { requireDeploymentTestImage } from "./containerFixture";

const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  }).trim();

test("compiled finish persists real storage retries and retains exhausted audio", () => {
  const image = requireDeploymentTestImage();
  const owner = `chronote-finish-${randomUUID()}`;
  const containers: string[] = [];
  const label = `chronote.finish.fixture=${owner}`;
  docker("network", "create", "--internal", "--label", label, owner);
  try {
    containers.push(
      docker(
        "run",
        "-d",
        "--network",
        owner,
        "--network-alias",
        "dynamodb",
        "--label",
        label,
        "amazon/dynamodb-local:3.1.0",
        "-jar",
        "DynamoDBLocal.jar",
        "-inMemory",
        "-sharedDb",
      ),
    );
    containers.push(
      docker(
        "run",
        "-d",
        "--network",
        owner,
        "--network-alias",
        "minio",
        "--label",
        label,
        "-e",
        "MINIO_ROOT_USER=generated",
        "-e",
        "MINIO_ROOT_PASSWORD=generated-password",
        "chronote-minio-test:source",
        "server",
        "/data",
      ),
    );
    const fixture = Buffer.from(JSON.stringify({ history })).toString("base64");
    const env = {
      FINISH_FIXTURE: fixture,
      MOCK_MODE: "false",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "generated",
      AWS_SECRET_ACCESS_KEY: "generated-password",
      AWS_EC2_METADATA_DISABLED: "true",
      STORAGE_ENDPOINT: "http://minio:9000",
      STORAGE_FORCE_PATH_STYLE: "true",
      TRANSCRIPTS_BUCKET: "generated-retry",
      OPENAI_API_KEY: "generated",
      DISCORD_BOT_TOKEN: "generated",
      DISCORD_CLIENT_ID: "generated",
      ENABLE_OAUTH: "false",
      ENABLE_MCP: "false",
      SESSION_SECRET: "generated",
      FRONTEND_SITE_URL: "http://localhost",
      LANGFUSE_TRACING_ENABLED: "false",
      APP_CONFIG_ENABLED: "false",
    };
    const runner = docker(
      "create",
      "--network",
      owner,
      "--label",
      label,
      "--mount",
      `type=bind,source=${path.resolve("test/deployment/fixtures/nativeCheckpointFinish.cjs")},target=/app/nativeCheckpointFinish.cjs,readonly`,
      ...Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      image,
      "node",
      "nativeCheckpointFinish.cjs",
    );
    containers.push(runner);
    const output = docker("start", "--attach", runner);
    expect(docker("inspect", "--format", "{{.State.ExitCode}}", runner)).toBe(
      "0",
    );
    const line = output
      .split(/\r?\n/)
      .find((value) => value.startsWith("CHECKPOINT_FINISH_RESULT="));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.split("=").slice(1).join("=")).results).toEqual([
      { succeeds: true, finished: true, attempts: 3, retainedFiles: 0 },
      { succeeds: false, finished: false, attempts: 3, retainedFiles: 1 },
    ]);
  } finally {
    for (const container of containers.reverse()) {
      expect(
        docker(
          "inspect",
          "--format",
          '{{index .Config.Labels "chronote.finish.fixture"}}',
          container,
        ),
      ).toBe(owner);
      docker("rm", "--force", "--volumes", container);
    }
    docker("network", "rm", owner);
  }
});
