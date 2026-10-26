const { trace } = require("@opentelemetry/api");
const {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require("@opentelemetry/sdk-trace-base");

async function main() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  const moduleMode = process.argv[3] ?? "cjs";
  const { default: OpenAI } =
    moduleMode === "esm" ? await import("openai") : require("openai");
  const { observeOpenAI } =
    moduleMode === "esm"
      ? await import("@langfuse/openai")
      : require("@langfuse/openai");
  const { LangfuseOtelSpanAttributes } = require("@langfuse/core");
  const providerResponse = JSON.parse(process.argv[2]);
  let requestCount = 0;
  const client = observeOpenAI(
    new OpenAI({
      apiKey: "synthetic",
      maxRetries: 0,
      fetch: async () => {
        requestCount += 1;
        return Response.json(providerResponse);
      },
    }),
  );

  try {
    const response = await client.responses.create({
      model: "synthetic",
      input: "synthetic",
    });
    await provider.forceFlush();
    const usageDetails = exporter
      .getFinishedSpans()
      .map(
        (span) =>
          span.attributes[LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS],
      )
      .filter((value) => typeof value === "string")
      .map((value) => JSON.parse(value));
    process.stdout.write(
      JSON.stringify({ requestCount, response, usageDetails }),
    );
  } finally {
    await provider.shutdown();
    trace.disable();
  }
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
