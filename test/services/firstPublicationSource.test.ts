import {
  normalizePublicationSelection,
  bindFirstPublicationSource,
} from "../../src/services/firstPublicationSource";
import { firstPublicationFixture } from "./firstPublication.fixture";
test("normalizes reusable selections and resolves bundle references without IO", () => {
  const f = firstPublicationFixture();
  const bundles = new Map([["bundle", { meetings: [{ key: f.key }] }]]);
  expect(
    normalizePublicationSelection([f.key, { bundle: "bundle" }], bundles),
  ).toEqual([f.key]);
  expect(() =>
    normalizePublicationSelection(
      Array.from({ length: 26 }, (_, i) => ({ ...f.key, guildId: String(i) })),
      bundles,
    ),
  ).toThrow();
  expect(() =>
    normalizePublicationSelection([{ bundle: "missing" }], bundles),
  ).toThrow();
});
test("strict v2 provenance supports absent previous artifacts and exact bytes", () => {
  const f = firstPublicationFixture();
  expect(
    bindFirstPublicationSource(f.profile, f.row, f.manifest, f.objects)
      .notesSha256,
  ).toBe(f.row.operatorRecovery?.notesSha256);
  for (const mutate of [
    (x: typeof f) => {
      x.objects.notes += " ";
    },
    (x: typeof f) => {
      x.manifest.meetingId = "wrong";
    },
    (x: typeof f) => {
      x.profile.accountId = "bad";
    },
    (x: typeof f) => {
      x.row.textChannelId = undefined;
    },
    (x: typeof f) => {
      x.manifest.publication = "active";
    },
  ]) {
    const x = firstPublicationFixture();
    mutate(x);
    expect(() =>
      bindFirstPublicationSource(x.profile, x.row, x.manifest, x.objects),
    ).toThrow();
  }
});

test("conflicting bundle identities for the same key are rejected", () => {
  const f = firstPublicationFixture(),
    bundles = new Map<string, unknown>([
      ["one", { meetings: [{ key: f.key, meetingId: "first" }] }],
      ["two", { meetings: [{ key: f.key, meetingId: "second" }] }],
    ]);
  expect(() =>
    normalizePublicationSelection(
      [{ bundle: "one" }, { bundle: "two" }],
      bundles,
    ),
  ).toThrow("Conflicting");
});
