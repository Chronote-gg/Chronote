/** @jest-environment node */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("Langfuse Metrics v2 cost report", () => {
  it("reports priced and unpriced groups without estimating missing cost", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              providedModelName: "priced-model",
              name: "notes",
              count_count: "3",
              sum_totalCost: "1.5",
              avg_latency: "2",
              p95_latency: "3",
            },
            {
              providedModelName: "unpriced-model",
              name: "tts",
              count_count: "2",
              sum_totalCost: null,
              avg_latency: "1",
              p95_latency: "1.5",
            },
          ],
        }),
      );
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Test server did not expose a TCP port.");
    }

    try {
      const script = path.join(
        process.cwd(),
        ".codex",
        "skills",
        "langfuse-metrics",
        "scripts",
        "query-metrics-v2.mjs",
      );
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          script,
          "cost-report",
          "--from",
          "2026-08-27T00:00:00Z",
          "--to",
          "2026-08-28T00:00:00Z",
          "--completed-meetings",
          "5",
          "--transcribed-minutes",
          "10",
          "--compact",
        ],
        {
          env: {
            ...process.env,
            LANGFUSE_PUBLIC_KEY: "test-public",
            LANGFUSE_SECRET_KEY: "test-secret",
            LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      );

      const output = JSON.parse(stdout);
      expect(output.report).toMatchObject({
        totalAttributedCost: 1.5,
        billableObservationCount: 5,
        observationsInPricedGroups: 3,
        observationsInUnpricedGroups: 2,
        pricedGroupObservationRatio: 0.6,
        unitCosts: {
          costPerCompletedMeeting: 0.3,
          costPerTranscribedMinute: 0.15,
        },
        unpricedGroups: [
          {
            providedModelName: "unpriced-model",
            name: "tts",
            observationCount: 2,
          },
        ],
      });

      const { stdout: zeroDenominatorStdout } = await execFileAsync(
        process.execPath,
        [
          script,
          "cost-report",
          "--from",
          "2026-08-27T00:00:00Z",
          "--to",
          "2026-08-28T00:00:00Z",
          "--completed-meetings",
          "0",
          "--transcribed-minutes",
          "0",
          "--compact",
        ],
        {
          env: {
            ...process.env,
            LANGFUSE_PUBLIC_KEY: "test-public",
            LANGFUSE_SECRET_KEY: "test-secret",
            LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      );
      expect(JSON.parse(zeroDenominatorStdout).report.unitCosts).toEqual({
        costPerCompletedMeeting: null,
        costPerTranscribedMinute: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
