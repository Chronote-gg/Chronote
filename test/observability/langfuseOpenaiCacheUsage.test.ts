/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Native Node keeps the SDK and Langfuse in one module graph and isolates OTel.
describe.each(["cjs", "esm"])(
  "Langfuse Responses cache usage through %s",
  (moduleMode) => {
    it.each([
      {
        name: "flat cache counts",
        inputDetails: { cached_tokens: 200, cache_write_tokens: 300 },
        expectedInput: 500,
      },
      {
        name: "a nested cache write breakdown with zero counts",
        inputDetails: {
          cached_tokens: 0,
          cache_write_tokens: 0,
          cache_write_tokens_details: {
            ttl_30m_tokens: 0,
            ttl_12h_tokens: 0,
          },
        },
        expectedInput: 1000,
      },
      {
        name: "a nested cache write breakdown with read and write counts",
        inputDetails: {
          cached_tokens: 200,
          cache_write_tokens: 300,
          cache_write_tokens_details: {
            ttl_30m_tokens: 100,
            ttl_12h_tokens: 200,
          },
        },
        expectedInput: 500,
      },
    ])(
      "records finite numeric usage for $name",
      async ({ inputDetails, expectedInput }) => {
        const providerUsage = {
          input_tokens: 1000,
          input_tokens_details: inputDetails,
          output_tokens: 100,
          output_tokens_details: { reasoning_tokens: 20 },
          total_tokens: 1100,
        };
        const providerResponse = {
          id: "resp_synthetic_cache_usage",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "synthetic",
          output: [],
          usage: providerUsage,
        };
        const child = spawnSync(
          process.execPath,
          [
            join(__dirname, "fixtures", "langfuseOpenaiCacheUsage.cjs"),
            JSON.stringify(providerResponse),
            moduleMode,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        const result = JSON.parse(child.stdout);
        expect(result.requestCount).toBe(1);
        expect(result.response).toMatchObject(providerResponse);
        expect(result.response.usage).toEqual(providerUsage);
        expect(result.usageDetails).toHaveLength(1);
        const [usageDetails] = result.usageDetails;
        expect(usageDetails).toEqual({
          input: expectedInput,
          output: 80,
          total: 1100,
          input_cached_tokens: inputDetails.cached_tokens,
          input_cache_write_tokens: inputDetails.cache_write_tokens,
          output_reasoning_tokens: 20,
        });
        expect(
          Object.values(usageDetails).every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ),
        ).toBe(true);
      },
    );
  },
);
