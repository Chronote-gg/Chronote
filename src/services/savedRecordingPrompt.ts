import { z } from "zod";
import { ChatPromptClient } from "@langfuse/client";
import { getLangfuseClient, isLangfuseEnabled } from "./langfuseClient";

const base = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  version: z.number().int().positive(),
});
// Text prompts remain readable for recordings saved with the former transcription prompt.
export const savedPromptSchema = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("text"), template: z.string() }).strict(),
  base
    .extend({
      type: z.literal("chat"),
      template: z.array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export type SavedRecordingPrompt = z.infer<typeof savedPromptSchema>;
export async function snapshotRecordingPrompt(
  name: string,
  label: string,
): Promise<SavedRecordingPrompt> {
  const client = getLangfuseClient();
  if (!isLangfuseEnabled() || !client)
    throw new Error("Recording prompt unavailable");
  const options = {
    label,
    cacheTtlSeconds: 0,
    maxRetries: 0,
    fetchTimeoutMs: 5000,
  };
  const prompt = await client.prompt.get(name, { ...options, type: "chat" });
  // Only reusable template data, never provider config or a live SDK instance.
  const template = prompt.prompt.map((message) =>
    "role" in message
      ? { role: message.role, content: message.content }
      : message,
  );
  return savedPromptSchema.parse({
    name: prompt.name,
    version: prompt.version,
    label,
    type: "chat",
    template,
  });
}
export function compileSavedChatPrompt(
  saved: SavedRecordingPrompt,
  variables: Record<string, string | number>,
): import("./langfusePromptService").ChatPromptResult {
  if (saved.type !== "chat")
    throw new Error("Saved generation prompt must be chat");
  const result = new ChatPromptClient({
    name: saved.name,
    version: saved.version,
    labels: [saved.label],
    tags: [],
    type: "chat",
    prompt: saved.template,
  }).compile(
    Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [key, String(value)]),
    ),
  );
  const messages = z
    .array(
      z
        .object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        })
        .strict(),
    )
    .parse(result);
  return {
    messages,
    source: "langfuse",
    langfusePrompt: {
      name: saved.name,
      version: saved.version,
      isFallback: false,
    },
  };
}
