"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
function assertProductionIdentity(actor, env = process.env) {
  const account = env.EXPECTED_ACCOUNT_ID;
  const role = env.EXPECTED_ROLE_ARN;
  const session = env.EXPECTED_SESSION_NAME;
  assert.match(account, /^\d{12}$/);
  assert.match(
    role,
    new RegExp(
      `^arn:aws:iam::${account}:role/[A-Za-z0-9_+=,.@/-]+-github-deploy$`,
    ),
  );
  assert.ok(!/sandbox|rehearsal/i.test(role));
  assert.match(session, /^chronote-production-[1-9]\d*-[1-9]\d*$/);
  assert.equal(actor.Account, account);
  assert.equal(
    actor.Arn,
    `arn:aws:sts::${account}:assumed-role/${role.split("/").at(-1)}/${session}`,
  );
}
module.exports = { assertProductionIdentity };
if (require.main === module) {
  try {
    assertProductionIdentity(JSON.parse(readFileSync(0, "utf8")));
    process.stdout.write("Production deployment identity verified\n");
  } catch {
    process.stderr.write("Production deployment identity mismatch\n");
    process.exitCode = 1;
  }
}
