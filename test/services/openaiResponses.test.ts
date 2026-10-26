import { expect, jest, test } from "@jest/globals";

const completed = (text: string) => ({
  status: "completed",
  output_text: text,
  output: [],
});

const truncated = (text: string) => ({
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output_text: text,
  output: [],
});

async function loadResponse(
  response: object | object[],
  model = "gpt-6.1-sol",
) {
  jest.resetModules();
  const responses = Array.isArray(response) ? response : [response];
  let callIndex = 0;
  const responsesCreate = jest.fn().mockImplementation(() => {
    const current = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    return Promise.resolve(current);
  });
  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient: jest.fn(() => ({
      responses: { create: responsesCreate },
    })),
    buildOpenAISafetyIdentifier: jest.fn(() => "safety-id"),
  }));
  jest.doMock("../../src/services/modelFactory", () => ({
    getModelChoice: jest.fn(() => ({ model })),
  }));
  jest.doMock("../../src/services/meetingModelOverrides", () => ({
    getMeetingModelOverrides: jest.fn(),
  }));
  jest.doMock("../../src/services/openaiModelParams", () => ({
    resolveChatParamsForRole: jest.fn(() => ({
      reasoning_effort: "low",
      verbosity: "low",
    })),
  }));
  const { chat } = await import("../../src/services/openaiChatService");
  const meeting = {
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
  };
  const options = { traceName: "notes" };
  const messages = [{ role: "user" as const, content: "Write the notes." }];
  return {
    run: (signal?: AbortSignal) =>
      chat(meeting, { messages }, { ...options, signal }),
    runCorrection: () =>
      chat(
        meeting,
        { messages },
        { ...options, modelParamRole: "notesCorrection" },
      ),
    runFrozen: () =>
      chat(
        meeting,
        { messages },
        {
          ...options,
          frozenModel: {
            provider: "openai",
            model: "gpt-5.2",
            params: { reasoning_effort: "none", temperature: 0 },
          },
        },
      ),
    responsesCreate,
    messages,
  };
}

test("Meeting text always uses Responses and translates frozen parameters", async () => {
  const fixture = await loadResponse({
    status: "completed",
    output_text: "Completed notes",
    output: [
      { type: "reasoning", id: "reasoning-1", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Completed notes" }],
      },
    ],
  });

  await expect(fixture.run()).resolves.toBe("Completed notes");
  expect(fixture.responsesCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gpt-6.1-sol",
      input: fixture.messages,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      store: false,
      safety_identifier: "safety-id",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(fixture.responsesCreate.mock.calls[0][0]).not.toHaveProperty(
    "prompt_cache_key",
  );
  expect(fixture.responsesCreate.mock.calls[0][0]).not.toHaveProperty(
    "prompt_cache_retention",
  );
  expect(fixture.messages).toEqual([
    { role: "user", content: "Write the notes." },
  ]);
});

test("Responses refuses to publish a refused generation", async () => {
  const fixture = await loadResponse({
    status: "completed",
    output_text: "",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "Cannot provide these notes." }],
      },
    ],
  });

  await expect(fixture.run()).rejects.toThrow(/refus/i);
});

test("Responses refuses to publish content-filtered partial text", async () => {
  const fixture = await loadResponse({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
    output_text: "Partial notes",
    output: [],
  });

  await expect(fixture.run()).rejects.toThrow(/incomplete/i);
});

test("Responses rejects a completed generation without usable text", async () => {
  const fixture = await loadResponse({
    status: "completed",
    output_text: "   ",
    output: [],
  });

  await expect(fixture.run()).rejects.toThrow(/empty/i);
});

test("Responses keeps frozen model parameters instead of new live defaults", async () => {
  const fixture = await loadResponse({
    status: "completed",
    output_text: "Recovered notes",
    output: [],
  });

  await expect(fixture.runFrozen()).resolves.toBe("Recovered notes");
  expect(fixture.responsesCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gpt-5.2",
      reasoning: { effort: "none" },
      temperature: 0,
    }),
    expect.anything(),
  );
  expect(fixture.responsesCreate.mock.calls[0][0]).not.toHaveProperty(
    "prompt_cache_options",
  );
});

test.each([
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6.1-sol-2026-10-01",
])(
  "notes on %s avoids cache writes for unique meeting inputs",
  async (model) => {
    const fixture = await loadResponse(completed("Notes"), model);

    await expect(fixture.run()).resolves.toBe("Notes");
    expect(fixture.responsesCreate.mock.calls[0][0]).toMatchObject({
      model,
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [{ role: "user", content: "Write the notes." }],
    });
  },
);

test.each([
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o-mini",
  "unknown-model",
])("notes on %s omits unsupported explicit-cache fields", async (model) => {
  const fixture = await loadResponse(completed("Notes"), model);

  await expect(fixture.run()).resolves.toBe("Notes");
  expect(fixture.responsesCreate.mock.calls[0][0]).not.toHaveProperty(
    "prompt_cache_options",
  );
});

test("non-notes chat roles keep their existing cache behavior", async () => {
  const fixture = await loadResponse(completed("Correction"));

  await expect(fixture.runCorrection()).resolves.toBe("Correction");
  expect(fixture.responsesCreate.mock.calls[0][0]).not.toHaveProperty(
    "prompt_cache_options",
  );
});

test("ordinary text callers keep their existing cache behavior", async () => {
  const fixture = await loadResponse(completed("Summary"));
  const { generateOpenAIText } =
    await import("../../src/services/openaiTextService");

  await expect(
    generateOpenAIText({
      model: "gpt-6.1-sol",
      modelParams: { reasoning_effort: "low" },
      input: [{ role: "user", content: "Write a summary." }],
    }),
  ).resolves.toBe("Summary");
  expect(fixture.responsesCreate.mock.calls[0][0]).not.toHaveProperty(
    "prompt_cache_options",
  );
});

test("Responses continuation preserves encrypted reasoning and assistant phase", async () => {
  const fixture = await loadResponse([
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "First ",
      output: [
        {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          encrypted_content: "encrypted-reasoning",
        },
        {
          type: "message",
          id: "message-1",
          role: "assistant",
          phase: "final_answer",
          status: "incomplete",
          content: [{ type: "output_text", text: "First ", annotations: [] }],
        },
      ],
    },
    { status: "completed", output_text: "second", output: [] },
  ]);

  await expect(fixture.run()).resolves.toBe("First second");
  for (const [request] of fixture.responsesCreate.mock.calls) {
    expect(request.prompt_cache_options).toEqual({
      mode: "explicit",
      ttl: "30m",
    });
    expect(request.input.slice(0, fixture.messages.length)).toEqual(
      fixture.messages,
    );
  }
  expect(fixture.responsesCreate.mock.calls[1][0].input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "encrypted-reasoning",
      }),
      expect.objectContaining({ role: "assistant", phase: "final_answer" }),
    ]),
  );
});

test("Responses never publishes a prefix when the request budget is exhausted", async () => {
  const fixture = await loadResponse(
    ["one", "two", "three"].map((text) => ({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: text,
      output: [],
    })),
  );

  await expect(fixture.run()).rejects.toThrow(/request limit/i);
  expect(fixture.responsesCreate).toHaveBeenCalledTimes(3);
});

test("Responses rejects reasoning-only truncation without repeating requests", async () => {
  const fixture = await loadResponse({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: "",
    output: [],
  });

  await expect(fixture.run()).rejects.toThrow(/incomplete/i);
  expect(fixture.responsesCreate).toHaveBeenCalledTimes(1);
});

test("Responses rejects truncated JSON instead of concatenating partial objects", async () => {
  await loadResponse({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: '{"summarySentence":',
    output: [],
  });
  const textService = await import("../../src/services/openaiTextService");

  await expect(
    textService.generateOpenAIText({
      model: "gpt-5.2",
      modelParams: { reasoning_effort: "none" },
      input: [{ role: "user", content: "Return a summary." }],
      format: { kind: "json_object" },
      maxOutputTokens: 160,
    }),
  ).rejects.toThrow(/incomplete/i);
});

test.each(["completed", "incomplete"])(
  "Responses rejects repeated text in a %s continuation",
  async (status) => {
    const repeated = { ...truncated("Repeated"), status };
    const fixture = await loadResponse([truncated("Repeated"), repeated]);

    await expect(fixture.run()).rejects.toThrow(/no progress/i);
    expect(fixture.responsesCreate).toHaveBeenCalledTimes(2);
  },
);

test("Responses rejects the accumulated prefix after continuation fails", async () => {
  const fixture = await loadResponse(truncated("First"));
  fixture.responsesCreate
    .mockResolvedValueOnce(truncated("First"))
    .mockRejectedValueOnce(new Error("provider failed"));

  await expect(fixture.run()).rejects.toThrow("provider failed");
});

test("Responses does not dispatch when already cancelled", async () => {
  const fixture = await loadResponse(completed("Unused"));
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));

  await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
  expect(fixture.responsesCreate).not.toHaveBeenCalled();
});

test("Responses checks cancellation when a continuation settles", async () => {
  const fixture = await loadResponse(truncated("First"));
  const controller = new AbortController();
  fixture.responsesCreate
    .mockResolvedValueOnce(truncated("First"))
    .mockImplementationOnce(() => {
      controller.abort(new Error("cancelled"));
      return Promise.resolve(completed("Second"));
    });

  await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
  expect(fixture.responsesCreate).toHaveBeenCalledTimes(2);
});

test("Responses stops after cancellation at the first settlement", async () => {
  const fixture = await loadResponse(truncated("First"));
  const controller = new AbortController();
  fixture.responsesCreate.mockImplementationOnce(() => {
    controller.abort(new Error("cancelled"));
    return Promise.resolve(truncated("First"));
  });

  await expect(fixture.run(controller.signal)).rejects.toThrow("cancelled");
  expect(fixture.responsesCreate).toHaveBeenCalledTimes(1);
});

test("Responses maps strict structured output to the requested schema", async () => {
  const fixture = await loadResponse(completed('{"title":"Notes"}'));
  const textService = await import("../../src/services/openaiTextService");
  const schema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  };

  await expect(
    textService.generateOpenAIText({
      model: "gpt-5.2",
      input: [{ role: "user", content: "Return a title as JSON." }],
      modelParams: { reasoning_effort: "none" },
      format: { kind: "json_schema", name: "meeting_title", schema },
      maxOutputTokens: 200,
    }),
  ).resolves.toBe('{"title":"Notes"}');
  expect(fixture.responsesCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      text: {
        format: {
          type: "json_schema",
          name: "meeting_title",
          schema,
          strict: true,
        },
      },
      max_output_tokens: 200,
    }),
    undefined,
  );
});
