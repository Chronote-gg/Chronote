"use strict";
const { readFileSync } = require("node:fs");
const assert = require("node:assert/strict");
function assertSandboxIdentity(actor, env = process.env) {
  const account = env.EXPECTED_ACCOUNT_ID;
  const role = env.EXPECTED_ROLE_ARN;
  const session = env.EXPECTED_SESSION_NAME;
  assert.match(account, /^\d{12}$/);
  assert.match(
    role,
    new RegExp(
      "^arn:aws:iam::" +
        account +
        ":role/[a-z0-9-]*sandbox[a-z0-9-]*-github-deploy$",
    ),
  );
  assert.match(session, /^chronote-sandbox-\d+-\d+$/);
  assert.equal(actor.Account, account);
  assert.equal(
    actor.Arn,
    role.replace(":iam:", ":sts:").replace(":role/", ":assumed-role/") +
      "/" +
      session,
  );
}
module.exports = { assertSandboxIdentity };
if (require.main === module) {
  try {
    assertSandboxIdentity(JSON.parse(readFileSync(0, "utf8")));
    process.stdout.write("Sandbox deployment identity verified\n");
  } catch {
    process.stderr.write("Sandbox deployment identity mismatch\n");
    process.exitCode = 1;
  }
}
