const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");

const readEnvFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath);
    return dotenv.parse(raw);
  } catch (error) {
    console.warn(`Failed reading ${filePath}:`, error);
    return {};
  }
};

const loadRepoEnv = () => {
  const base = readEnvFile(path.join(repoRoot, ".env"));
  const local = readEnvFile(path.join(repoRoot, ".env.local"));
  return { ...base, ...local };
};

const parseArgs = (argv) => {
  const args = argv.slice(2);
  const mode = args[0];
  const flags = new Set(args.slice(1));
  return {
    mode,
    printEnv: flags.has("--print-env"),
    dryRun: flags.has("--dry-run"),
    skipDocker: flags.has("--skip-docker"),
  };
};

const redactKeys = new Set([
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_SECRET",
  "OPENAI_API_KEY",
  "LANGFUSE_SECRET_KEY",
  "OAUTH_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

const formatEnvValue = (key, value) => {
  if (redactKeys.has(key)) return "(redacted)";
  return value;
};

const printLoadedEnv = (envVars) => {
  const keys = [
    "DISCORD_CLIENT_ID",
    "DISCORD_BOT_TOKEN",
    "OPENAI_API_KEY",
    "USE_LOCAL_DYNAMODB",
    "ENABLE_OAUTH",
    "PORT",
  ];

  console.log("Loaded env (from .env / .env.local):");
  for (const key of keys) {
    const value = envVars[key] ?? process.env[key];
    if (value === undefined || value === "") {
      console.log(`- ${key}=<unset>`);
      continue;
    }
    console.log(`- ${key}=${formatEnvValue(key, value)}`);
  }
};

const resolveInnerScript = (mode, skipDocker) => {
  const map = {
    dev: skipDocker ? "start:inner" : "dev:inner",
    "dev:mock": skipDocker ? "start:mock:inner" : "dev:mock:inner",
    start: "start:inner",
    "start:mock": "start:mock:inner",
  };
  return map[mode];
};

const run = async () => {
  const { mode, printEnv, dryRun, skipDocker } = parseArgs(process.argv);

  const inner = resolveInnerScript(mode, skipDocker);
  if (!inner) {
    console.error(
      "Usage: node scripts/dev.js <dev|dev:mock|start|start:mock> [--skip-docker] [--print-env] [--dry-run]",
    );
    process.exit(2);
  }

  const envVars = loadRepoEnv();
  const env = { ...process.env, ...envVars };
  if (printEnv) {
    printLoadedEnv(envVars);
  }

  const yarnCmd = process.platform === "win32" ? "yarn.cmd" : "yarn";
  const args = ["run", inner];
  const commandLabel = `${yarnCmd} ${args.join(" ")}`;

  if (dryRun) {
    console.log(`Dry run: would execute ${commandLabel}`);
    process.exit(0);
  }

  console.log(`Running: ${commandLabel}`);
  const child = spawn(yarnCmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
};

void run();
