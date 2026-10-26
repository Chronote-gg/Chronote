// Install before application imports in cold, generated fixtures. Unexpected egress fails locally.
const http = require("node:http");
const https = require("node:https");
function assertLoopback(target, defaultProtocol) {
  const host =
    typeof target === "string" || target instanceof URL
      ? new URL(target).hostname
      : (target.hostname ?? target.host ?? "localhost");
  const hostname = String(host).replace(/^\[/, "").replace(/\]$/, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname))
    throw new Error(
      `Cold fixture blocked ${defaultProtocol} provider dispatch`,
    );
}
for (const [client, protocol] of [
  [http, "http"],
  [https, "https"],
]) {
  const request = client.request;
  client.request = function (target, ...rest) {
    assertLoopback(target, protocol);
    return request.call(this, target, ...rest);
  };
  client.get = function (...args) {
    const request = client.request(...args);
    request.end();
    return request;
  };
}
const fetch = globalThis.fetch;
if (fetch)
  globalThis.fetch = (target, options) => {
    assertLoopback(
      typeof target === "object" && "url" in target ? target.url : target,
      "fetch",
    );
    return fetch(target, options);
  };
