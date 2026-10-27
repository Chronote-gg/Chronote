import { fullAcceptance } from "./fixtures/fullAcceptance.js";
test.each(["normal", "repair"])(
  "authenticated %s package with synthetic OIDC-only reviewed routes, content, maximum renewal history and native final transactions",
  async (path) => {
    await fullAcceptance(path);
  },
  240000,
);

test.each(["persist_acceptance", "reopen_admission", "release_deployment"])(
  "fresh %s collector refuses actual static deployment source before any native transition",
  async (purpose) => {
    await fullAcceptance("normal", "static-route", purpose);
  },
  240000,
);

test.each([
  "expiry-before-dispatch",
  "expiry-after-submitted",
  "late-ack",
  "lost-ack",
])(
  "authenticated native final boundary retains holds and forbids replay: %s",
  async (fault) => {
    await fullAcceptance("normal", fault);
  },
  240000,
);

test.each(["reopen_admission", "release_deployment"])(
  "lost native ACK records the actual atomic %s outcome without authorizing replay",
  async (purpose) => {
    await fullAcceptance("normal", "lost-ack", purpose);
  },
  240000,
);

test.each(["normal", "repair"])(
  "preserves the original two paused drafts through authenticated %s native acceptance",
  async (path) => {
    const result = await fullAcceptance(
      path,
      undefined,
      "persist_acceptance",
      true,
    );
    expect(result.pausedIds).toEqual(["one", "two"]);
    expect(result.finalPurposes).toEqual([
      "persist_acceptance",
      "reopen_admission",
      "release_deployment",
    ]);
  },
  240000,
);

test("lost native initialize ACK cannot authenticate present original pause markers", async () => {
  expect(
    await fullAcceptance(
      "normal",
      "initialize-lost-ack",
      "persist_acceptance",
      true,
    ),
  ).toEqual({ initializationRefused: true });
}, 240000);

test("native final CAS refuses a paused marker changed after authenticated collection", async () => {
  await fullAcceptance(
    "normal",
    "paused-marker-after-collect",
    "persist_acceptance",
    true,
  );
}, 240000);
