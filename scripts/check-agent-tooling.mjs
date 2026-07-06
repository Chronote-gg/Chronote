import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];

function repoPath(...parts) {
  return path.join(root, ...parts);
}

function relativePath(...parts) {
  return parts.join("/");
}

function readText(...parts) {
  return fs.readFileSync(repoPath(...parts), "utf8");
}

function readJson(...parts) {
  return JSON.parse(readText(...parts));
}

function requireFile(...parts) {
  const filePath = repoPath(...parts);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    failures.push(`Missing file: ${relativePath(...parts)}`);
  }
}

function listSkills(rootDir) {
  const dir = repoPath(rootDir, "skills");
  if (!fs.existsSync(dir)) {
    failures.push(`Missing skill directory: ${rootDir}/skills`);
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function requireJsonPath(object, label, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, part)) {
      failures.push(`Missing ${label}: ${pathParts.join(".")}`);
      return;
    }
    current = current[part];
  }
}

for (const file of [
  ["AGENTS.md"],
  ["CLAUDE.md"],
  ["opencode.json"],
  [".mcp.json"],
  [".codex", "config.toml"],
]) {
  requireFile(...file);
}

const skillRoots = {
  Claude: ".claude",
  Codex: ".codex",
  OpenCode: ".opencode",
};
const skillInventory = Object.fromEntries(
  Object.entries(skillRoots).map(([client, dir]) => [client, listSkills(dir)]),
);
const expectedSkills = [
  ...new Set(Object.values(skillInventory).flat()),
].sort();

for (const [client, skills] of Object.entries(skillInventory)) {
  for (const skill of expectedSkills) {
    if (!skills.includes(skill)) {
      failures.push(`${client} is missing skill mirror: ${skill}`);
    }
  }

  for (const skill of skills) {
    requireFile(skillRoots[client], "skills", skill, "SKILL.md");
  }
}

const opencode = readJson("opencode.json");
for (const server of ["langfuse", "langfuse_obs", "langfuse_docs"]) {
  requireJsonPath(opencode, "OpenCode MCP server", ["mcp", server]);
}

const claudeMcp = readJson(".mcp.json");
for (const server of ["langfuse", "langfuse-docs"]) {
  requireJsonPath(claudeMcp, "Claude MCP server", ["mcpServers", server]);
}

const codexConfig = readText(".codex", "config.toml");
const codexChecks = [
  {
    label: "Codex Langfuse prompt MCP",
    pattern:
      /\[mcp_servers\.langfuse\][\s\S]*?url\s*=\s*"https:\/\/us\.cloud\.langfuse\.com\/api\/public\/mcp"/,
  },
  {
    label: "Codex Langfuse auth header",
    pattern:
      /(env_http_headers\s*=\s*\{\s*Authorization\s*=\s*"LANGFUSE_MCP_AUTH"\s*\}|\[mcp_servers\.langfuse\.env_http_headers\][\s\S]*?Authorization\s*=\s*"LANGFUSE_MCP_AUTH")/,
  },
  {
    label: "Codex Langfuse docs MCP",
    pattern:
      /\[mcp_servers\.(langfuse_docs|langfuse-docs)\][\s\S]*?url\s*=\s*"https:\/\/langfuse\.com\/api\/mcp"/,
  },
];

for (const { label, pattern } of codexChecks) {
  if (!pattern.test(codexConfig)) {
    failures.push(`Missing ${label} in .codex/config.toml`);
  }
}

if (
  /\[mcp_servers\.langfuse_docs\]/.test(codexConfig) &&
  /\[mcp_servers\.langfuse-docs\]/.test(codexConfig)
) {
  warnings.push(
    "Codex config defines both langfuse_docs and langfuse-docs docs MCP aliases.",
  );
}

if (failures.length > 0) {
  console.error("Agent tooling check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Agent tooling check passed.");
console.log(`Skills: ${expectedSkills.join(", ")}`);
if (warnings.length > 0) {
  console.warn("Warnings:");
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}
