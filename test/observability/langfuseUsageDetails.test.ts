import {
  buildLangfuseTranscriptionAccounting,
  LANGFUSE_AUDIO_SECONDS_USAGE_KEY,
} from "../../src/observability/langfuseUsageDetails";

describe("buildLangfuseTranscriptionAccounting", () => {
  it("maps token usage to Langfuse's priced generic token keys", () => {
    expect(
      buildLangfuseTranscriptionAccounting([
        {
          type: "tokens",
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
        },
      ]),
    ).toEqual({
      usageDetails: { input: 120, output: 30, total: 150 },
      status: "priced",
      requestCount: 1,
      pricedRequestCount: 1,
      unpricedRequestCount: 0,
    });
  });

  it("aggregates both requests made by a transcription vote", () => {
    expect(
      buildLangfuseTranscriptionAccounting([
        {
          type: "tokens",
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
        {
          type: "tokens",
          input_tokens: 80,
          output_tokens: 10,
          total_tokens: 90,
        },
      ]),
    ).toMatchObject({
      usageDetails: { input: 180, output: 30, total: 210 },
      status: "priced",
      requestCount: 2,
      pricedRequestCount: 2,
      unpricedRequestCount: 0,
    });
  });

  it("marks mixed token and missing usage as partial", () => {
    expect(
      buildLangfuseTranscriptionAccounting([
        {
          type: "tokens",
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
        undefined,
      ]),
    ).toMatchObject({
      usageDetails: { input: 100, output: 20, total: 120 },
      status: "partial",
      requestCount: 2,
      pricedRequestCount: 1,
      unpricedRequestCount: 1,
    });
  });

  it("keeps duration usage visible without calling it priced", () => {
    const result = buildLangfuseTranscriptionAccounting([
      { type: "duration", seconds: 12.34567 },
    ]);

    expect(result).toEqual({
      usageDetails: {
        [LANGFUSE_AUDIO_SECONDS_USAGE_KEY]: 12.346,
      },
      status: "unpriced",
      requestCount: 1,
      pricedRequestCount: 0,
      unpricedRequestCount: 1,
    });
  });

  it("uses valid fallback audio seconds when provider usage is missing", () => {
    expect(buildLangfuseTranscriptionAccounting([undefined], 8.7654)).toEqual({
      usageDetails: { [LANGFUSE_AUDIO_SECONDS_USAGE_KEY]: 8.765 },
      status: "unpriced",
      requestCount: 1,
      pricedRequestCount: 0,
      unpricedRequestCount: 1,
    });
    expect(
      buildLangfuseTranscriptionAccounting([undefined], Number.NaN)
        .usageDetails,
    ).toBeUndefined();
  });

  it("does not call invalid provider token usage priced", () => {
    expect(
      buildLangfuseTranscriptionAccounting([
        {
          type: "tokens",
          input_tokens: Number.NaN,
          output_tokens: 20,
          total_tokens: 20,
        },
      ]),
    ).toMatchObject({
      usageDetails: undefined,
      status: "unpriced",
      pricedRequestCount: 0,
      unpricedRequestCount: 1,
    });
  });
});
