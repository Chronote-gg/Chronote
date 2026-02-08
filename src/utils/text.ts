/**
 * Remove leading/trailing Markdown code fences from a string.
 * Preserves inner content; noop if no wrapping fence.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  // drop opening fence (may include language)
  lines.shift();
  // drop closing fence if present
  if (lines.length && lines[lines.length - 1].startsWith("```")) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}
