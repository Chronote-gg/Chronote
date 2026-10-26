/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
const sync = workflow.jobs["sync-openai-connection"];
const step = sync?.steps.find(
  (item: { name: string }) => item.name === "Sync serving OpenAI connection",
);

test("production connection sync requires a successful backend and the event revision", () => {
  expect(sync.needs).toEqual(["deploybackend"]);
  expect(sync.if).toBeUndefined();
  expect(sync.environment).toBe("production");
  expect(workflow.on).not.toHaveProperty("pull_request");
  const checkout = sync.steps.find((item: { uses?: string }) =>
    item.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout.with?.ref).toBeUndefined();
  expect(step.run).not.toMatch(
    /GITHUB_(ENV|OUTPUT|STEP_SUMMARY)|upload-artifact|set -x/,
  );
});

test.each(["ci.yml", "ci-core.yml", "deploy-staging.yml"])(
  "%s never pushes live LLM connections",
  (name) => {
    expect(readFileSync(`.github/workflows/${name}`, "utf8")).not.toContain(
      "llm-connections:push",
    );
  },
);

const mockShell = `
aws() {
  printf '%s\\n' "$1 $2" >> aws-calls.txt
  case "$1 $2" in
    "ecs describe-services")
      [[ "$*" == *"--cluster fixture-cluster"* ]] || return 91
      [[ "$*" == *"--services fixture-service"* ]] || return 91
      if [ "$FIXTURE_FAILURE" = service ]; then
        printf '%s' None
      else
        printf '%s' fixture-serving-task-definition
      fi
      ;;
    "ecs describe-task-definition")
      [[ "$*" == *"--task-definition fixture-serving-task-definition"* ]] || return 92
      [ "$FIXTURE_FAILURE" != definition ] || return 1
      if [ "$FIXTURE_FAILURE" = invalid-json ]; then
        printf '%s' not-json
      else
        printf '%s' "$FIXTURE_TASK_DEFINITION"
      fi
      ;;
    "secretsmanager get-secret-value")
      [[ "$*" == *"--secret-id fixture/openai-api-key"* ]] || return 93
      [[ "$*" == *"--version-stage AWSCURRENT"* ]] || return 93
      [ "$FIXTURE_FAILURE" != key ] || return 1
      if [ "$FIXTURE_FAILURE" = empty-key ]; then
        printf '%s' '  '
      else
        printf '%s' fixture-key
      fi
      ;;
    *) return 94 ;;
  esac
}
yarn() {
  local directory="$3"
  local files=("$directory"/*)
  [ "$OPENAI_API_KEY" = fixture-key ] || return 95
  [ "$OPENAI_PROJECT_ID" = fixture-project ] || return 95
  [ "$2" = --dir ] || return 96
  [ "\${#files[@]}" = 1 ] || return 96
  [ "\${files[0]##*/}" = openai.yml ] || return 96
  [ "$(< "$directory/openai.yml")" = "$(< langfuse/llm-connections/openai.yml)" ] || return 96
  printf '%s|%s\\n' "$1" "\${4:-}" >> yarn-calls.txt
  printf '%s\\n' "$directory" > connection-directory.txt
  printf '%s\\n' 'Connection command validated'
  [ "$FIXTURE_FAILURE" != dry-run ] || return 1
  if [ "$FIXTURE_FAILURE" = push ] && [ "\${4:-}" != --dry-run ]; then return 1; fi
  return 0
}
`;

function runSync(failure = "", prefix = "") {
  const directory = mkdtempSync(join(tmpdir(), "openai-sync-test-"));
  const connections = join(directory, "langfuse/llm-connections");
  mkdirSync(connections, { recursive: true });
  writeFileSync(
    join(connections, "openai.yml"),
    readFileSync("langfuse/llm-connections/openai.yml", "utf8"),
  );
  writeFileSync(join(connections, "bedrock.yml"), "provider: bedrock\n");
  const environment = [
    { name: "DDB_TABLE_PREFIX", value: "fixture-" },
    {
      name: "OPENAI_PROJECT_ID",
      value: failure === "project" ? "" : "fixture-project",
    },
  ];
  if (failure === "duplicate-project") environment.push(environment[1]);
  const app = { name: "fixture-bot", environment };
  const sidecar = {
    name: "sidecar",
    environment: [{ name: "OPENAI_PROJECT_ID", value: "wrong-project" }],
  };
  const containers = failure === "app" ? [sidecar] : [sidecar, app];
  if (failure === "duplicate-app") containers.push(app);
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `${mockShell}
(${step.run})
sync_status=$?
if [ -f connection-directory.txt ]; then
  IFS= read -r connection_directory < connection-directory.txt
  [ ! -d "$connection_directory" ] || exit 97
fi
exit "$sync_status"`,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          ECS_CLUSTER: "fixture-cluster",
          ECS_SERVICE: "fixture-service",
          ECS_TASK_FAMILY: "fixture-bot-task",
          SECRETS_PREFIX: prefix,
          FIXTURE_FAILURE: failure,
          FIXTURE_TASK_DEFINITION: JSON.stringify({
            taskDefinition: { containerDefinitions: containers },
          }),
          GITHUB_ENV: "github-env",
          GITHUB_OUTPUT: "github-output",
          GITHUB_STEP_SUMMARY: "github-summary",
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(97);
    for (const file of ["github-env", "github-output", "github-summary"]) {
      expect(existsSync(join(directory, file))).toBe(false);
    }
    const calls = join(directory, "yarn-calls.txt");
    const yarn = existsSync(calls)
      ? readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("|"))
      : [];
    const visible = result.stdout.replace(/^::add-mask::.*$/gm, "");
    expect(visible + result.stderr).not.toMatch(
      /fixture-key|fixture-project|wrong-project/,
    );
    return { ...result, yarn };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each(["", "fixture"])(
  "sync isolates OpenAI and verifies the push with prefix %j",
  (prefix) => {
    const result = runSync("", prefix);
    expect(result.status).toBe(0);
    expect(result.yarn).toEqual([
      ["llm-connections:push", "--dry-run"],
      ["llm-connections:push", ""],
      ["llm-connections:check", ""],
    ]);
    expect(result.stdout).toContain("::add-mask::fixture-key");
    expect(result.stdout).toContain("::add-mask::fixture-project");
    expect(result.stdout.indexOf("::add-mask::fixture-key")).toBeLessThan(
      result.stdout.indexOf("Connection command validated"),
    );
    expect(result.stdout.indexOf("::add-mask::fixture-project")).toBeLessThan(
      result.stdout.indexOf("Connection command validated"),
    );
  },
);

test.each([
  "service",
  "definition",
  "invalid-json",
  "app",
  "duplicate-app",
  "key",
  "empty-key",
  "project",
  "duplicate-project",
])("missing or invalid %s fails before any connection push", (failure) => {
  const result = runSync(failure);
  expect(result.status).not.toBe(0);
  expect(result.yarn).toEqual([]);
  expect(result.stdout + result.stderr).toContain("ERROR:");
});

test.each([
  { failure: "dry-run", calls: 1 },
  { failure: "push", calls: 2 },
])(
  "a failed $failure prevents later commands and cleans up",
  ({ failure, calls }) => {
    const result = runSync(failure);
    expect(result.status).not.toBe(0);
    expect(result.yarn).toHaveLength(calls);
  },
);
