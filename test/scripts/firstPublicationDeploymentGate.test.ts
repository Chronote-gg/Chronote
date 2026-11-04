/** @jest-environment node */
import { reservePublicationCompatibility } from "../../scripts/deployment/publication-compatibility.cjs";
test("incompatible deployment reserves against exact pins before any runtime writes", async () => {
  const calls: unknown[] = [];
  const aws = async (s: string, o: string, p: unknown) => {
    calls.push({ s, o, p });
    return {};
  };
  await reservePublicationCompatibility({
    aws,
    table: "control",
    control: { servingGeneration: 1, coordinatorEpoch: 1 },
    images: ["unknown"],
    runToken: "deploy",
    releases: { contract: "first_publication_archive_fence_v1", images: [] },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    s: "dynamodb",
    o: "update-item",
    p: { ConditionExpression: expect.stringContaining("publicationPins") },
  });
});
test("pins exclude unknown deployment while a known compatible release proceeds", async () => {
  const aws = jest.fn();
  const control = {
    publicationPins: { run: { authorities: ["one"], settled: [] } },
    servingGeneration: 1,
    coordinatorEpoch: 1,
  };
  await expect(
    reservePublicationCompatibility({
      aws,
      table: "control",
      control,
      images: ["old"],
      runToken: "deploy",
      releases: {
        contract: "first_publication_archive_fence_v1",
        images: ["new"],
      },
    }),
  ).rejects.toThrow("publication");
  expect(aws).not.toHaveBeenCalled();
  await reservePublicationCompatibility({
    aws,
    table: "control",
    control,
    images: ["new"],
    runToken: "deploy",
    releases: {
      contract: "first_publication_archive_fence_v1",
      images: ["new"],
    },
  });
  expect(aws).not.toHaveBeenCalled();
});
