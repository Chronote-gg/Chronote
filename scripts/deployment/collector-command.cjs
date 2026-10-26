"use strict";
const assert = require("node:assert/strict");
const { payloadSource, digest } = require("./collector-payload.cjs");
const transport = "ecs-exec-embedded-v1";
function commandTemplate() {
  return {
    transport,
    source: payloadSource(),
    loader:
      'const c=require("node:crypto");const s=Buffer.from("__SOURCE__","base64"),i=Buffer.from("__INPUT__","base64");const h=b=>c.createHash("sha256").update(b).digest("hex");if(h(s)!=="SOURCE_HASH"||h(i)!=="INPUT_HASH")throw Error("UNKNOWN");eval(s.toString()+";runPayload("+i.toString()+","+JSON.stringify({sourceSha256:h(s),inputSha256:h(i)})+");");',
  };
}
function collectorTemplateSha256() {
  return digest(JSON.stringify(commandTemplate()));
}
function captureNamespace(m, manifestSha256) {
  assert.ok(
    ["production-introduction", "rehearsal-introduction"].includes(m.kind),
  );
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  return `${m.kind}/${m.binding.operationId}/${manifestSha256}`;
}
function renderCollector(m, base) {
  assert.ok(
    ![
      "commandSha256",
      "inputSha256",
      "commandTemplateSha256",
      "transport",
      "sourceSha256",
    ].some((key) => Object.hasOwn(base, key)),
    "Self-referential input",
  );
  const template = commandTemplate(),
    commandTemplateSha256 = collectorTemplateSha256();
  assert.equal(
    m.collectorCommandTemplateSha256,
    commandTemplateSha256,
    "Unreviewed collector template",
  );
  const input = JSON.stringify({
    request: base,
    binding: m.binding,
    containerName: m.containerName,
  });
  assert.ok(Buffer.byteLength(input) <= 16384);
  const sourceSha256 = digest(template.source),
    inputSha256 = digest(input);
  const loader = template.loader
    .replace("__SOURCE__", Buffer.from(template.source).toString("base64"))
    .replace("__INPUT__", Buffer.from(input).toString("base64"))
    .replace("SOURCE_HASH", sourceSha256)
    .replace("INPUT_HASH", inputSha256);
  const command = "/usr/local/bin/node -e '" + loader + "'";
  return {
    command,
    input,
    request: {
      ...base,
      transport,
      commandTemplateSha256,
      sourceSha256,
      inputSha256,
      commandSha256: digest(command),
    },
  };
}
function verifyCollectorRequest(m, request) {
  const base = { ...request };
  for (const key of [
    "transport",
    "commandTemplateSha256",
    "sourceSha256",
    "inputSha256",
    "commandSha256",
  ])
    delete base[key];
  const rendered = renderCollector(m, base);
  assert.deepEqual(
    request,
    rendered.request,
    "Collector command binding changed",
  );
  return rendered;
}
module.exports = {
  renderCollector,
  verifyCollectorRequest,
  collectorTemplateSha256,
  captureNamespace,
};
