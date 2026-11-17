/** @jest-environment node */
import type { ClientOptions } from "openai";
import { setTimeout as wait } from "node:timers/promises";
import {
  buildTracingFixture,
  deferred,
  validResponse,
  waitFor,
  withTracingFixture,
} from "../fixtures/transcriptionTracing";

jest.setTimeout(30_000);

function providerTransport(respond: (attempt: number) => Promise<Response>) {
  const calls: string[] = [];
  const fetch: NonNullable<ClientOptions["fetch"]> = async (_url, init) => {
    const body = await new Response(init?.body).text();
    expect(body).not.toContain('name="prompt"');
    expect(body).not.toContain('name="language"');
    calls.push(body);
    return respond(calls.length);
  };
  return { fetch, calls };
}

const unavailable = () =>
  Response.json(
    { error: { message: "synthetic unavailable" } },
    { status: 503, headers: { "retry-after-ms": "0" } },
  );

test("a transient retry retains the later success and prepares the attachment once", async () => {
  const provider = providerTransport(async (attempt) =>
    attempt === 1 ? unavailable() : Response.json(validResponse),
  );
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "succeeded",
      text: validResponse.text,
    });
    expect(provider.calls).toHaveLength(2);
    expect(f.helperStarted).toHaveBeenCalledTimes(1);
    expect(f.inputClosed).toHaveBeenCalledTimes(2);
    expect(f.state.metadata).toMatchObject({
      transcriptionSdkInvocationCount: 2,
      transcriptionHttpDispatchAttemptCount: 2,
      transcriptionRetryCount: 1,
      transcriptionKnownUsageAttemptCount: 1,
      transcriptionUnknownUsageAttemptCount: 1,
      transcriptionAttemptUsageCoverage: "partial",
      transcriptionCostAccountingStatus: "partial",
      transcriptionRequestCount: 1,
    });
    expect(f.state.usageDetails).toEqual({ input: 23, output: 11, total: 34 });
  });
});

test("a request may use four attempts but never a fifth", async () => {
  const provider = providerTransport(async (attempt) =>
    attempt < 4 ? unavailable() : Response.json(validResponse),
  );
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(provider.calls).toHaveLength(4);
    expect(f.state.metadata).toMatchObject({
      transcriptionHttpDispatchAttemptCount: 4,
      transcriptionRetryCount: 3,
      transcriptionKnownUsageAttemptCount: 1,
      transcriptionUnknownUsageAttemptCount: 3,
    });
  });
});

test("accounting observation failure cannot replace a successful ASR result", async () => {
  const provider = providerTransport(async () => Response.json(validResponse));
  await withTracingFixture(
    { transport: provider.fetch, accountingFailure: true },
    async (f) => {
      f.attachment.resolve();
      await expect(f.transcribe()).resolves.toMatchObject({
        status: "succeeded",
        text: validResponse.text,
      });
      expect(provider.calls).toHaveLength(1);
    },
  );
});

test("new diagnostics exclude provider body, header, path and identifier sentinels", async () => {
  const secret = "PRIVATE_ASR_SENTINEL";
  const provider = providerTransport(async () =>
    Response.json(
      { error: { message: secret, code: secret, request_id: secret } },
      { status: 400, headers: { "x-private-header": secret } },
    ),
  );
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({ status: "failed" });
    expect(JSON.stringify(f.state.metadata)).not.toContain(secret);
    expect(f.state.metadata).toMatchObject({
      transcriptionHttpDispatchAttemptCount: 1,
      transcriptionUnknownUsageAttemptCount: 1,
      transcriptionAttemptUsageCoverage: "unknown",
    });
  });
});

test("real bulkhead retires an aborted queued item and starts the next while another remains active", async () => {
  const held = [deferred<void>(), deferred<void>()];
  const started = [deferred<void>(), deferred<void>(), deferred<void>()];
  const provider = providerTransport(async (attempt) => {
    started[attempt - 1]?.resolve();
    await held[attempt - 1]?.promise;
    return Response.json(validResponse);
  });
  const f = await buildTracingFixture({
    realPolicies: true,
    transport: provider.fetch,
  });
  const aborted = new AbortController();
  try {
    f.attachment.resolve();
    const first = f.transcribe();
    const second = f.transcribe();
    await started[0].promise;
    await started[1].promise;
    const third = f.transcribe({ signal: aborted.signal });
    const fourth = f.transcribe();
    await f.waitForQueuedJobs(2);
    aborted.abort();
    held[0].resolve();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    await expect(third).resolves.toMatchObject({ status: "failed" });
    await waitFor(
      started[2].promise,
      "eligible job after aborted queue item",
      3_000,
    );
    expect(provider.calls).toHaveLength(3);
    await expect(fourth).resolves.toMatchObject({ status: "succeeded" });
    held[1].resolve();
    await expect(second).resolves.toMatchObject({ status: "succeeded" });
  } finally {
    held.forEach((work) => work.resolve());
    await f.dispose();
  }
});

test("real policy keeps the concurrency slot until attachment work drains", async () => {
  const entered = [deferred<void>(), deferred<void>(), deferred<void>()];
  const provider = providerTransport(async (attempt) => {
    entered[attempt - 1]?.resolve();
    return Response.json(validResponse);
  });
  const f = await buildTracingFixture({
    realPolicies: true,
    transport: provider.fetch,
  });
  try {
    const first = f.transcribe();
    const second = f.transcribe();
    const third = f.transcribe();
    await entered[0].promise;
    await entered[1].promise;
    await wait(1_000);
    expect(provider.calls).toHaveLength(2);
    f.attachment.resolve();
    await Promise.all([first, second, third]);
    expect(provider.calls).toHaveLength(3);
  } finally {
    await f.dispose();
  }
});

test.each([
  {
    name: "counts five exhausted logical ASR failures, then rejects before dispatch",
    respond: unavailable,
    calls: 20,
  },
  {
    name: "ignores terminal provider failures",
    respond: () =>
      Response.json({ error: { message: "terminal" } }, { status: 400 }),
    calls: 6,
  },
])("real breaker $name", async ({ respond, calls }) => {
  const provider = providerTransport(async () => respond());
  await withTracingFixture(
    { realPolicies: true, transport: provider.fetch },
    async (f) => {
      f.attachment.resolve();
      for (let logical = 0; logical < 6; logical += 1) {
        await expect(f.transcribe()).resolves.toMatchObject({
          status: "failed",
        });
      }
      expect(provider.calls).toHaveLength(calls);
    },
  );
});

test("real bulkhead admits two active and one hundred queued jobs", async () => {
  const release = deferred<void>();
  const bothActive = deferred<void>();
  const provider = providerTransport(async (attempt) => {
    if (attempt === 2) bothActive.resolve();
    await release.promise;
    return Response.json(validResponse);
  });
  const f = await buildTracingFixture({
    realPolicies: true,
    transport: provider.fetch,
  });
  const controllers = Array.from({ length: 101 }, () => new AbortController());
  try {
    f.attachment.resolve();
    const active = [f.transcribe(), f.transcribe()];
    await bothActive.promise;
    const queued = controllers.map((controller) =>
      f.transcribe({ signal: controller.signal }),
    );
    await expect(queued[100]).resolves.toMatchObject({ status: "failed" });
    expect(provider.calls).toHaveLength(2);
    controllers.forEach((controller) => controller.abort());
    release.resolve();
    await Promise.all([...active, ...queued]);
    expect(provider.calls).toHaveLength(2);
  } finally {
    controllers.forEach((controller) => controller.abort());
    release.resolve();
    await f.dispose();
  }
});

test("real limiter spaces logical starts and records queue wait", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const starts: number[] = [];
  const provider = providerTransport(async () => {
    starts.push(performance.now());
    if (starts.length === 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    return Response.json(validResponse);
  });
  try {
    await withTracingFixture(
      { realPolicies: true, transport: provider.fetch },
      async (f) => {
        f.attachment.resolve();
        const tasks = [f.transcribe(), f.transcribe()];
        await jest.advanceTimersByTimeAsync(1_000);
        await Promise.all(tasks);
        expect(starts).toHaveLength(2);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(780);
        expect(
          f.state.metadata?.transcriptionQueueWaitMs,
        ).toBeGreaterThanOrEqual(700);
      },
    );
  } finally {
    jest.useRealTimers();
  }
});

test("accounting failure preserves the provider error", async () => {
  await withTracingFixture({ accountingFailure: true }, async (f) => {
    const providerError = new Error("original provider failure");
    f.create.mockRejectedValueOnce(providerError);
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "failed",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.policyRejected).toHaveBeenCalledTimes(1);
    expect(f.policyRejected.mock.calls[0][0]).toBe(providerError);
  });
});

test("a response without logprobs is counted and logged", async () => {
  const withoutLogprobs = { ...validResponse, logprobs: undefined };
  const provider = providerTransport(async () =>
    Response.json(withoutLogprobs),
  );
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    const { metricsRegistry } = await import("../../src/metrics");
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "succeeded",
    });
    const metric = await metricsRegistry
      .getSingleMetric("chronote_transcription_missing_logprobs_total")
      ?.get();
    expect(metric?.values.map((value) => value.value)).toEqual([1]);
    expect(console.warn).toHaveBeenCalledWith(
      "Transcription response has no logprobs.",
      expect.objectContaining({ model: expect.any(String) }),
    );
  });
});

test("a response without text remains an empty result", async () => {
  const withoutText = { ...validResponse, text: undefined };
  const provider = providerTransport(async () => Response.json(withoutText));
  await withTracingFixture({ transport: provider.fetch }, async (f) => {
    f.attachment.resolve();
    await expect(f.transcribe()).resolves.toMatchObject({
      status: "succeeded",
      text: "",
    });
    expect(provider.calls).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalledWith(
      "Transcription response has no logprobs.",
      expect.anything(),
    );
  });
});
