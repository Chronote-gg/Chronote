const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const envCandidates = [".env.local", ".env"];
const resolvedEnvFile = envCandidates.find((candidate) =>
  existsSync(candidate),
);

if (resolvedEnvFile) {
  dotenv.config({ path: resolvedEnvFile });
} else {
  console.warn("No .env.local or .env found, continuing without dotenv.");
}

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

if (!publicKey || !secretKey) {
  console.error(
    "Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY in .env.local/.env.",
  );
  process.exit(1);
}

const token = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
const authValue = `Basic ${token}`;

const targetDir = path.join(process.cwd(), ".opencode");
const targetPath = path.join(targetDir, "langfuse.mcp.auth");
const publicKeyPath = path.join(targetDir, "langfuse.public");
const secretKeyPath = path.join(targetDir, "langfuse.secret");

if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}

writeFileSync(targetPath, authValue, "utf8");
writeFileSync(publicKeyPath, publicKey, "utf8");
writeFileSync(secretKeyPath, secretKey, "utf8");

console.log(`Wrote Langfuse MCP auth file to ${targetPath}`);
console.log(`Wrote Langfuse MCP public key file to ${publicKeyPath}`);
console.log(`Wrote Langfuse MCP secret key file to ${secretKeyPath}`);
