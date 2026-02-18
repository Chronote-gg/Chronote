import { diffLines, type Change } from "diff";

/** Lines of unchanged context shown above/below each changed region. */
const DEFAULT_CONTEXT_LINES = 3;

/** Separator between non-adjacent hunks. */
const HUNK_SEPARATOR = "---";

interface FormatHunkDiffOptions {
  /** Max total characters in the output (truncated with suffix if exceeded). */
  charLimit?: number;
  /** Max total output lines (truncated if exceeded). */
  lineLimit?: number;
  /** Lines of unchanged context around each change. */
  contextLines?: number;
}

/**
 * Split a Change value into individual lines, dropping the trailing empty
 * element that `String.split("\n")` produces when the string ends with `\n`.
 */
function splitChangeLines(change: Change): string[] {
  const raw = change.value.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  return raw;
}

/**
 * Expand `diffLines` output into per-line entries tagged with their kind,
 * preserving source ordering.
 */
function expandToTaggedLines(
  changes: Change[],
): { kind: "add" | "remove" | "context"; text: string }[] {
  const result: { kind: "add" | "remove" | "context"; text: string }[] = [];
  for (const change of changes) {
    const kind = change.added ? "add" : change.removed ? "remove" : "context";
    for (const line of splitChangeLines(change)) {
      result.push({ kind, text: line });
    }
  }
  return result;
}

/**
 * Build a set of line indices that should appear in the output: every changed
 * line plus `contextLines` unchanged lines on each side.
 */
function buildVisibleSet(
  tagged: { kind: "add" | "remove" | "context" }[],
  contextLines: number,
): Set<number> {
  const visible = new Set<number>();
  for (let i = 0; i < tagged.length; i++) {
    if (tagged[i].kind !== "context") {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(tagged.length - 1, i + contextLines);
      for (let j = start; j <= end; j++) {
        visible.add(j);
      }
    }
  }
  return visible;
}

/**
 * Produce a compact, GitHub-style hunk diff showing only changed lines with a
 * few lines of surrounding context. Non-adjacent hunks are separated by `---`.
 *
 * Output format per line:
 * - `+ added line`
 * - `- removed line`
 * - `  context line`
 *
 * Returns an empty string when the texts are identical (after trimming).
 */
export function formatHunkDiff(
  current: string,
  proposed: string,
  options: FormatHunkDiffOptions = {},
): string {
  if (current.trim() === proposed.trim()) return "";

  const {
    charLimit,
    lineLimit,
    contextLines = DEFAULT_CONTEXT_LINES,
  } = options;

  const changes = diffLines(current, proposed);
  const tagged = expandToTaggedLines(changes);
  const visible = buildVisibleSet(tagged, contextLines);

  const output: string[] = [];
  let lastVisibleIndex = -1;

  for (let i = 0; i < tagged.length; i++) {
    if (!visible.has(i)) continue;

    if (lastVisibleIndex !== -1 && i - lastVisibleIndex > 1) {
      output.push(HUNK_SEPARATOR);
    }
    lastVisibleIndex = i;

    const { kind, text } = tagged[i];
    const prefix = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
    output.push(`${prefix} ${text}`);

    if (lineLimit && output.length >= lineLimit) break;
  }

  let result = output.join("\n");

  if (charLimit && result.length > charLimit) {
    const suffix = "\n... (truncated)";
    result = result.substring(0, charLimit - suffix.length) + suffix;
  }

  return result;
}
