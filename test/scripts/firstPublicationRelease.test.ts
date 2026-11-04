/** @jest-environment node */
import { buildPublicationRelease } from "../../scripts/operator/build-publication-release.cjs";
test("release packaging retains compatible digests and does not invent legacy compatibility", () => {
  const a = "sha256:" + "a".repeat(64),
    b = "sha256:" + "b".repeat(64);
  expect(buildPublicationRelease([a], "repo@" + b)).toEqual({
    contract: "first_publication_archive_fence_v1",
    images: [a, b],
  });
  expect(buildPublicationRelease(undefined, "repo@" + b).images).toEqual([b]);
  expect(() => buildPublicationRelease(["legacy:tag"], "repo@" + b)).toThrow();
  expect(() => buildPublicationRelease([], "repo:tag")).toThrow();
});
