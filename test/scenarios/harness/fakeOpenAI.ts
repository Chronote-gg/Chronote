import path from "node:path";
import { APIError } from "openai";
import { ChatPromptClient, TextPromptClient } from "@langfuse/client";
import {
  buildPromptPath,
  readPromptFileResolved,
} from "../../../scripts/prompts/shared";
import { completedTextResponse } from "../../../src/testSupport/openaiResponse";
import type * as LangfusePromptService from "../../../src/services/langfusePromptService";
import type * as OpenAIClientModule from "../../../src/services/openaiClient";
import type * as SavedRecordingPrompt from "../../../src/services/savedRecordingPrompt";
import type { WorkerGate } from "./world";

export type OpenAICallKind = "transcription" | "text";
export type OpenAICall = { kind: OpenAICallKind; request: unknown };

const PROMPTS_DIR = path.resolve(__dirname, "../../../prompts");
const DEFAULT_OUTPUT: Record<OpenAICallKind, string> = {
  transcription: "Synthetic speech from the scenario.",
  text: "Synthetic notes from the scenario.",
};
const DEFAULT_FAILURE_STATUS = 500;

/** Scripted OpenAI shared by every worker: outputs are consumed in order, then defaults apply. */
export class FakeOpenAI {
  readonly calls: OpenAICall[] = [];
  private readonly scripts: Record<OpenAICallKind, string[]> = {
    transcription: [],
    text: [],
  };
  private readonly failures: Record<OpenAICallKind, number[]> = {
    transcription: [],
    text: [],
  };
  private readonly hooks: ((call: OpenAICall) => void | Promise<void>)[] = [];

  /** Runs before each call is answered; a hook that awaits holds the call. */
  onCall(hook: (call: OpenAICall) => void | Promise<void>): void {
    this.hooks.push(hook);
  }

  private async answer(kind: OpenAICallKind, request: unknown) {
    for (const hook of this.hooks) await hook({ kind, request });
    return this.respond(kind, request);
  }

  script(kind: OpenAICallKind, ...outputs: string[]): void {
    this.scripts[kind].push(...outputs);
  }

  failNext(kind: OpenAICallKind, times = 1, status = DEFAULT_FAILURE_STATUS) {
    for (let index = 0; index < times; index += 1)
      this.failures[kind].push(status);
  }

  private respond(kind: OpenAICallKind, request: unknown): string {
    this.calls.push({ kind, request });
    const status = this.failures[kind].shift();
    if (status !== undefined)
      throw APIError.generate(
        status,
        { message: "Scripted OpenAI failure" },
        "Scripted OpenAI failure",
        new Headers(),
      );
    return this.scripts[kind].shift() ?? DEFAULT_OUTPUT[kind];
  }

  createModule(actual: typeof OpenAIClientModule, gate: WorkerGate) {
    const client = {
      audio: {
        transcriptions: {
          create: async (request: unknown) => {
            gate.assertAlive();
            return { text: await this.answer("transcription", request) };
          },
        },
      },
      responses: {
        create: async (request: unknown) => {
          gate.assertAlive();
          return completedTextResponse(await this.answer("text", request));
        },
      },
      withOptions: () => client,
    };
    return { ...actual, createOpenAIClient: () => client };
  }
}

/** Serves prompts from the repo's prompt files instead of Langfuse, compiled by the Langfuse SDK. */
export function createPromptModule(actual: typeof LangfusePromptService) {
  const load = (name: string) =>
    readPromptFileResolved(buildPromptPath(PROMPTS_DIR, name), PROMPTS_DIR);
  const meta = (name: string) => ({ name, version: 1, isFallback: false });
  type Variables = Parameters<
    typeof actual.getLangfuseTextPrompt
  >[0]["variables"];
  const compiledVariables = (variables: Variables = {}) =>
    Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [
        key,
        String(value ?? ""),
      ]),
    );
  const getLangfuseTextPrompt: typeof actual.getLangfuseTextPrompt = async ({
    name,
    variables,
  }) => {
    const file = await load(name);
    if (typeof file.prompt !== "string")
      throw new Error(`Prompt ${name} is not a text prompt`);
    const client = new TextPromptClient({
      name,
      version: 1,
      type: "text",
      prompt: file.prompt,
      labels: file.labels,
      tags: file.tags,
      config: file.config,
    });
    return {
      prompt: client.compile(compiledVariables(variables)),
      langfusePrompt: meta(name),
      source: "langfuse",
    };
  };
  const getLangfuseChatPrompt: typeof actual.getLangfuseChatPrompt = async ({
    name,
    variables,
  }) => {
    const file = await load(name);
    if (typeof file.prompt === "string")
      throw new Error(`Prompt ${name} is not a chat prompt`);
    const client = new ChatPromptClient({
      name,
      version: 1,
      type: "chat",
      prompt: file.prompt.map((message) => ({
        type: "chatmessage",
        ...message,
      })),
      labels: file.labels,
      tags: file.tags,
      config: file.config,
    });
    return {
      messages: client.compile(compiledVariables(variables)).map((message) => {
        if (
          !("content" in message) ||
          (message.role !== "system" &&
            message.role !== "user" &&
            message.role !== "assistant")
        )
          throw new Error(`Prompt ${name} has an unsupported message`);
        return { role: message.role, content: message.content };
      }),
      langfusePrompt: meta(name),
      source: "langfuse",
    };
  };
  return {
    ...actual,
    getLangfuseTextPrompt,
    getLangfuseChatPrompt,
    verifyLangfusePrompts: async () => undefined,
  };
}

/** The prompt snapshot a recording saves for recovery, from the same repo prompt files. */
export function createSavedPromptModule(actual: typeof SavedRecordingPrompt) {
  const snapshotRecordingPrompt: typeof actual.snapshotRecordingPrompt = async (
    name,
    type,
    label,
  ) => {
    const file = await readPromptFileResolved(
      buildPromptPath(PROMPTS_DIR, name),
      PROMPTS_DIR,
    );
    return actual.savedPromptSchema.parse({
      name,
      version: 1,
      label,
      type,
      template: file.prompt,
    });
  };
  return { ...actual, snapshotRecordingPrompt };
}
