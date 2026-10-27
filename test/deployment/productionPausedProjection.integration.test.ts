import { randomUUID } from "node:crypto";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { bound, fixture } from "../fixtures/productionManifest.js";
import { createProductionAws } from "../../scripts/deployment/production-aws.cjs";
import {
  createIntroductionTable,
  putIntroductionDocument,
  introductionClient,
} from "./fixtures/introductionStore";

jest.mock("@aws-sdk/client-dynamodb", () =>
  jest
    .requireActual("./fixtures/loopbackDynamoMock")
    .createLoopbackDynamoMock(),
);
let mockScope: object;
jest.mock("../../scripts/deployment/production-paused-drafts.cjs", () => ({
  readPausedReaderScope: () => mockScope,
}));
jest.mock("../../scripts/deployment/production-launcher-settings.cjs", () => ({
  readPausedEffectivePolicyScope: () => ({ scopeSha256: "a".repeat(64) }),
}));

afterAll(() => introductionClient.destroy());
afterEach(() => jest.restoreAllMocks());

test("native keyed parent filter proves list cardinality while indexed projections omit all source text", async () => {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const manifest = fixture();
  manifest.resources.tables.personalJob = `paused-projection-${randomUUID()}`;
  await createIntroductionTable(manifest.resources.tables.personalJob, [
    "uploadId",
  ]);
  const binding = bound(manifest);
  mockScope = {
    manifest: binding.manifest,
    identities: [{ uploadId: "one", ownerUserId: "owner", sourceCount: 2 }],
    objects: [],
  };
  const provider = createProductionAws(binding);
  const readParent = () =>
    provider.pausedDraftMetadata({}, {}, { kind: "parent", uploadId: "one" });
  const original = {
    uploadId: "one",
    ownerUserId: "owner",
    status: "pending_upload",
    title: "private parent title",
    error: "private error",
    sourceManifest: [
      {
        sourceId: "mic",
        kind: "owner_mic",
        label: "private mic label",
        originalFileName: "private-mic.wav",
      },
      {
        sourceId: "system",
        kind: "system_output",
        label: "private system label",
        sourceS3Key: "recordings/source",
        fileSize: 4,
        contentType: "audio/wav",
        originalFileName: "private-system.wav",
      },
    ],
  };
  await putIntroductionDocument(
    manifest.resources.tables.personalJob,
    original,
  );
  const response = await readParent();
  expect(response.Count).toBe(1);
  expect(response.Items.map(unmarshall)).toEqual([
    {
      uploadId: "one",
      ownerUserId: "owner",
      status: "pending_upload",
      sourceManifest: [
        { sourceId: "mic", kind: "owner_mic" },
        {
          sourceId: "system",
          kind: "system_output",
          sourceS3Key: "recordings/source",
          fileSize: 4,
          contentType: "audio/wav",
        },
      ],
    },
  ]);
  for (const sourceManifest of [
    original.sourceManifest.slice(0, 1),
    { 0: original.sourceManifest[0], 1: original.sourceManifest[1] },
  ]) {
    await putIntroductionDocument(manifest.resources.tables.personalJob, {
      ...original,
      sourceManifest,
    });
    expect((await readParent()).Items).toEqual([]);
  }
  await putIntroductionDocument(manifest.resources.tables.personalJob, {
    ...original,
    sourceManifest: [
      original.sourceManifest[0],
      { label: "only omitted text" },
    ],
  });
  const malformed = await readParent();
  // A missing structural member is visible as a shortened projection and must fail the cohort schema.
  expect(malformed.Items.map(unmarshall)[0].sourceManifest).toEqual([
    { sourceId: "mic", kind: "owner_mic" },
  ]);
});
