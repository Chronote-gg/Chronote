/** @jest-environment node */
import { inspectFirstPublicationRuntime } from "../../src/services/firstPublicationRuntime";
import { firstPublicationFixture } from "./firstPublication.fixture";
const image = "sha256:" + "a".repeat(64);
function fixture() {
  return {
    control: {
      publicationProtocol: 1,
      servingGeneration: 1,
      coordinatorEpoch: 1,
      servingMembers: { one: { imageDigest: image } },
      deployment: { phase: "complete" },
    },
    list: async () => [{ taskArn: "one", imageDigests: [image], ready: true }],
    releases: {
      contract: "first_publication_archive_fence_v1",
      images: [image],
    },
  };
}
test("all services must have a stable known compatible cohort", async () => {
  const f = fixture();
  const profile = firstPublicationFixture().profile;
  expect(
    await inspectFirstPublicationRuntime(profile, {
      readControl: async () => f.control,
      listServiceTasks: f.list,
      releases: f.releases,
    }),
  ).toMatchObject({ kind: "compatible", generation: 1 });
  f.releases.images = [];
  expect(
    await inspectFirstPublicationRuntime(profile, {
      readControl: async () => f.control,
      listServiceTasks: f.list,
      releases: f.releases,
    }),
  ).toMatchObject({
    kind: "blocked",
    reason: expect.stringContaining("operator release"),
  });
});
test("mixed replacing tasks and generation drift block without writes", async () => {
  const f = fixture();
  const deps = {
    readControl: async () => f.control,
    listServiceTasks: async () => [
      { taskArn: "old", imageDigests: [image], ready: false },
    ],
    releases: f.releases,
  };
  expect(
    (
      await inspectFirstPublicationRuntime(
        firstPublicationFixture().profile,
        deps,
      )
    ).kind,
  ).toBe("blocked");
  let n = 0;
  deps.listServiceTasks = f.list;
  deps.readControl = async () => ({ ...f.control, servingGeneration: ++n });
  expect(
    (
      await inspectFirstPublicationRuntime(
        firstPublicationFixture().profile,
        deps,
      )
    ).kind,
  ).toBe("blocked");
});
