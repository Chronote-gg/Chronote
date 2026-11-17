/** @jest-environment node */
import { S3VectorsClient, type Index } from "@aws-sdk/client-s3vectors";
import { configureSearchIndex } from "../../scripts/search/configure-s3-search";

const arn =
  "arn:aws:s3vectors:us-east-1:123456789012:bucket/synthetic-search/index/meetings-g1";
const ready: Index = {
  indexArn: arn,
  indexName: "meetings-g1",
  vectorBucketName: "synthetic-search",
  creationTime: new Date(0),
  dataType: "float32",
  dimension: 1536,
  distanceMetric: "cosine",
  indexMode: "ENHANCED",
  metadataConfiguration: {
    nonFilterableMetadataKeys: ["search_text"],
    textSearchConfigurations: [
      { metadataKey: "search_text", status: "ACTIVE" },
    ],
  },
};

describe("versioned search configuration", () => {
  const client = new S3VectorsClient({ region: "us-east-1" });
  const send = jest.spyOn(client, "send");
  beforeEach(() => send.mockReset());
  afterAll(() => client.destroy());

  it("checks matching configuration without writes", async () => {
    send.mockResolvedValue({ index: ready });
    await expect(configureSearchIndex(client, arn)).resolves.toMatchObject({
      version: 1,
      textStatus: "ACTIVE",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails closed on drift in check mode", async () => {
    send.mockResolvedValue({ index: { ...ready, indexMode: "CLASSIC" } });
    await expect(configureSearchIndex(client, arn)).rejects.toThrow(
      "configuration drift",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never repairs incompatible dimensions by replacing data", async () => {
    send.mockResolvedValue({ index: { ...ready, dimension: 3072 } });
    await expect(configureSearchIndex(client, arn, true)).rejects.toThrow(
      "Immutable",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads before patching only missing fields and waits for ACTIVE", async () => {
    jest.useFakeTimers();
    send.mockResolvedValueOnce({
      index: {
        ...ready,
        indexMode: "CLASSIC",
        metadataConfiguration: { nonFilterableMetadataKeys: ["search_text"] },
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({ index: ready });
    const result = configureSearchIndex(client, arn, true);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ textStatus: "ACTIVE" });
    expect(
      send.mock.calls.map(([command]) => command.constructor.name),
    ).toEqual([
      "GetIndexCommand",
      "UpdateIndexModeCommand",
      "UpdateMetadataConfigurationCommand",
      "GetIndexCommand",
    ]);
    jest.useRealTimers();
  });

  it("rejects unexpected searchable fields instead of deleting them", async () => {
    send.mockResolvedValue({
      index: {
        ...ready,
        metadataConfiguration: {
          ...ready.metadataConfiguration,
          textSearchConfigurations: [
            { metadataKey: "other", status: "ACTIVE" },
          ],
        },
      },
    });
    await expect(configureSearchIndex(client, arn, true)).rejects.toThrow(
      "Unexpected",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid target before making requests", async () => {
    await expect(configureSearchIndex(client, "wrong")).rejects.toThrow(
      "explicit us-east-1",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds an analyzer that never becomes ACTIVE", async () => {
    send.mockResolvedValue({
      index: {
        ...ready,
        metadataConfiguration: {
          ...ready.metadataConfiguration,
          textSearchConfigurations: [
            { metadataKey: "search_text", status: "BUILDING" },
          ],
        },
      },
    });
    await expect(configureSearchIndex(client, arn, true, 10)).rejects.toThrow();
  });
});
