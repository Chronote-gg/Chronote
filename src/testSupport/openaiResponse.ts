import type { Response } from "openai/resources/responses/responses";

export function completedTextResponse(outputText: string) {
  return {
    status: "completed",
    output_text: outputText,
    output: [],
  } satisfies Pick<Response, "status" | "output_text" | "output">;
}
