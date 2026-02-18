import { formatHunkDiff } from "../../src/utils/diff";

/**
 * Helper: build a newline-terminated string from an array of line strings.
 */
function lines(...args: string[]): string {
  return args.join("\n") + "\n";
}

/**
 * Helper: generate numbered lines like "line 0", "line 1", ...
 */
function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i}`);
}

describe("formatHunkDiff", () => {
  // ── identity / no-op ───────────────────────────────────────────────

  it("returns empty string for identical texts", () => {
    const text = "line one\nline two\nline three\n";
    expect(formatHunkDiff(text, text)).toBe("");
  });

  it("returns empty string for texts identical after trimming", () => {
    expect(formatHunkDiff("  hello  \n", "hello\n")).toBe("");
  });

  // ── default context (3 lines) ─────────────────────────────────────

  describe("default context (3 lines)", () => {
    it("shows 3 context lines on each side of a change", () => {
      // 15 lines, change at index 7 (middle)
      const src = numberedLines(15);
      const mod = [...src];
      mod[7] = "CHANGED";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      // 3 context before
      expect(result).toContain("  line 4");
      expect(result).toContain("  line 5");
      expect(result).toContain("  line 6");
      // the change
      expect(result).toContain("- line 7");
      expect(result).toContain("+ CHANGED");
      // 3 context after
      expect(result).toContain("  line 8");
      expect(result).toContain("  line 9");
      expect(result).toContain("  line 10");

      // beyond the window
      expect(result).not.toContain("  line 3");
      expect(result).not.toContain("  line 11");
    });

    it("clamps context at the start of the file", () => {
      const src = numberedLines(10);
      const mod = [...src];
      mod[1] = "CHANGED";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      // only 1 line before (index 0), nothing above that
      expect(result).toContain("  line 0");
      expect(result).toContain("- line 1");
      expect(result).toContain("+ CHANGED");
      expect(result).toContain("  line 2");
      expect(result).toContain("  line 3");
      expect(result).toContain("  line 4");
    });

    it("clamps context at the end of the file", () => {
      const src = numberedLines(10);
      const mod = [...src];
      mod[8] = "CHANGED";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).toContain("  line 5");
      expect(result).toContain("  line 6");
      expect(result).toContain("  line 7");
      expect(result).toContain("- line 8");
      expect(result).toContain("+ CHANGED");
      // only 1 context line after (index 9)
      expect(result).toContain("  line 9");
    });
  });

  // ── hunk merging ──────────────────────────────────────────────────

  describe("hunk merging", () => {
    it("merges hunks when gap equals 1 unchanged line (contextLines=3)", () => {
      // changes at index 3 and index 10; gap of 6 unchanged lines (4-9)
      // context windows: 3+change at 3 covers 0..6, 3+change at 10 covers 7..13
      // the windows touch/overlap at index 6-7, so they merge
      const src = numberedLines(20);
      const mod = [...src];
      mod[3] = "FIRST";
      mod[10] = "SECOND";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).not.toContain("---");
      expect(result).toContain("+ FIRST");
      expect(result).toContain("+ SECOND");
      // the in-between lines should all appear as context
      expect(result).toContain("  line 4");
      expect(result).toContain("  line 5");
      expect(result).toContain("  line 6");
      expect(result).toContain("  line 7");
      expect(result).toContain("  line 8");
      expect(result).toContain("  line 9");
    });

    it("merges when context windows exactly touch (no overlap)", () => {
      // With contextLines=3: change at 5 covers 2..8, change at 12 covers 9..15
      // They touch at 8-9 (consecutive indices), so the visible set is contiguous
      const src = numberedLines(20);
      const mod = [...src];
      mod[5] = "AAA";
      mod[12] = "BBB";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).not.toContain("---");
      expect(result).toContain("+ AAA");
      expect(result).toContain("+ BBB");
    });

    it("merges when context windows overlap by multiple lines", () => {
      // changes 2 apart with contextLines=3 -- heavy overlap
      const src = numberedLines(15);
      const mod = [...src];
      mod[5] = "AAA";
      mod[7] = "BBB";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).not.toContain("---");
      // the single gap line between changes should be context
      expect(result).toContain("  line 6");
    });

    it("separates hunks when gap exceeds 2 * contextLines", () => {
      // changes at 3 and 17 with contextLines=3
      // first covers 0..6, second covers 14..20 -- gap between 6 and 14
      const src = numberedLines(25);
      const mod = [...src];
      mod[3] = "FIRST";
      mod[17] = "SECOND";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).toContain("---");
      expect(result).toContain("+ FIRST");
      expect(result).toContain("+ SECOND");

      // lines in the gap should NOT appear
      expect(result).not.toContain("  line 10");
      expect(result).not.toContain("  line 11");
    });

    it("separates hunks with exactly 1-line gap in visible set", () => {
      // With contextLines=3: change at 3 covers 0..6, change at 11 covers 8..14
      // gap at index 7 -- not visible, so separator inserted
      const src = numberedLines(20);
      const mod = [...src];
      mod[3] = "FIRST";
      mod[11] = "SECOND";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).toContain("---");
    });

    it("merges three nearby changes into one hunk", () => {
      const src = numberedLines(20);
      const mod = [...src];
      mod[2] = "A";
      mod[5] = "B";
      mod[8] = "C";

      const result = formatHunkDiff(lines(...src), lines(...mod));

      expect(result).not.toContain("---");
      expect(result).toContain("+ A");
      expect(result).toContain("+ B");
      expect(result).toContain("+ C");
    });

    it("produces two separate hunks for three changes when outer ones are far apart", () => {
      const src = numberedLines(30);
      const mod = [...src];
      mod[2] = "A";
      mod[5] = "B"; // merges with A (gap = 2, within 2*3)
      mod[25] = "C"; // far away

      const result = formatHunkDiff(lines(...src), lines(...mod));

      const separators = result.split("\n").filter((l) => l === "---");
      expect(separators).toHaveLength(1);
    });
  });

  // ── custom contextLines ───────────────────────────────────────────

  describe("custom contextLines", () => {
    it("contextLines=0 shows only changes", () => {
      const src = numberedLines(10);
      const mod = [...src];
      mod[5] = "CHANGED";

      const result = formatHunkDiff(lines(...src), lines(...mod), {
        contextLines: 0,
      });

      expect(result).toContain("- line 5");
      expect(result).toContain("+ CHANGED");
      expect(result).not.toContain("  line 4");
      expect(result).not.toContain("  line 6");
    });

    it("contextLines=1 merges changes 2 apart but not 4 apart", () => {
      const src = numberedLines(20);
      const mod = [...src];
      mod[3] = "A";
      mod[5] = "B"; // gap 1 -- merges (1+1 >= gap)
      mod[15] = "C"; // far away

      const result = formatHunkDiff(lines(...src), lines(...mod), {
        contextLines: 1,
      });

      // A and B merge, C is separate
      const parts = result.split("---");
      expect(parts).toHaveLength(2);
      expect(parts[0]).toContain("+ A");
      expect(parts[0]).toContain("+ B");
      expect(parts[1]).toContain("+ C");
    });

    it("contextLines=5 with explicit override", () => {
      const src = numberedLines(20);
      const mod = [...src];
      mod[10] = "CHANGED";

      const result = formatHunkDiff(lines(...src), lines(...mod), {
        contextLines: 5,
      });

      expect(result).toContain("  line 5");
      expect(result).toContain("  line 15");
      expect(result).not.toContain("  line 4");
    });
  });

  // ── limits ────────────────────────────────────────────────────────

  describe("limits", () => {
    it("respects charLimit and truncates", () => {
      const src = Array.from({ length: 50 }, (_, i) => `original line ${i}`);
      const mod = src.map((l) => l.replace("original", "modified"));

      const result = formatHunkDiff(lines(...src), lines(...mod), {
        charLimit: 200,
      });

      expect(result.length).toBeLessThanOrEqual(200);
      expect(result).toContain("... (truncated)");
    });

    it("does not add truncation suffix when under charLimit", () => {
      const result = formatHunkDiff("a\n", "b\n", { charLimit: 5000 });

      expect(result).not.toContain("truncated");
    });

    it("respects lineLimit", () => {
      const src = numberedLines(100);
      const mod = src.map((l) => l.toUpperCase());

      const result = formatHunkDiff(lines(...src), lines(...mod), {
        lineLimit: 10,
      });
      const outputLines = result.split("\n");

      expect(outputLines.length).toBeLessThanOrEqual(10);
    });

    it("does not exceed Discord 1800 char budget for typical notes", () => {
      const noteLines = Array.from(
        { length: 80 },
        (_, i) => `- Meeting point ${i}`,
      );
      const current = ["## Summary", ...noteLines, "", "## End"].join("\n");
      const proposed = current
        .replace("Meeting point 10", "UPDATED point 10")
        .replace("Meeting point 50", "UPDATED point 50");

      const result = formatHunkDiff(current, proposed, { charLimit: 1800 });
      expect(result.length).toBeLessThanOrEqual(1800);
    });
  });

  // ── edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles additions at the end", () => {
      const result = formatHunkDiff(
        "first\nsecond\n",
        "first\nsecond\nthird\nfourth\n",
      );

      expect(result).toContain("+ third");
      expect(result).toContain("+ fourth");
      expect(result).toContain("  second");
    });

    it("handles deletions", () => {
      const result = formatHunkDiff("first\nsecond\nthird\n", "first\nthird\n");

      expect(result).toContain("- second");
      expect(result).not.toContain("+ second");
    });

    it("handles complete replacement", () => {
      const result = formatHunkDiff("old content\n", "new content\n");

      expect(result).toContain("- old content");
      expect(result).toContain("+ new content");
    });

    it("handles additions at the beginning", () => {
      const result = formatHunkDiff("existing\n", "new line\nexisting\n");

      expect(result).toContain("+ new line");
      expect(result).toContain("  existing");
    });

    it("handles single-line files", () => {
      const result = formatHunkDiff("old\n", "new\n");

      expect(result).toBe("- old\n+ new");
    });

    it("handles empty to non-empty", () => {
      const result = formatHunkDiff("", "hello\n");

      expect(result).toContain("+ hello");
    });

    it("handles non-empty to empty", () => {
      const result = formatHunkDiff("hello\n", "");

      expect(result).toContain("- hello");
    });
  });

  // ── realistic scenario ────────────────────────────────────────────

  it("works with real meeting notes content", () => {
    const current = [
      "## Summary",
      "- Quick check-in meeting",
      "- Discussed ticket system fix",
      "- Auction closeout status reviewed",
      "- Retro feedback process continuing",
      "",
      "## Action Items",
      "- Fix ticket permissions",
      "- Catalog auction results",
      "- Schedule retro meeting",
      "",
      "## Details",
      "Long paragraph of meeting details that stays the same...",
      "Another unchanged paragraph...",
      "More unchanged content...",
    ].join("\n");

    const proposed = current
      .replace("Quick check-in meeting", "Short debrief after charity event")
      .replace(
        "Fix ticket permissions",
        "Adjust @everyone perms for attachments in tickets",
      );

    const result = formatHunkDiff(current, proposed);

    // changed lines
    expect(result).toContain("+ - Short debrief after charity event");
    expect(result).toContain("- - Quick check-in meeting");
    expect(result).toContain(
      "+ - Adjust @everyone perms for attachments in tickets",
    );
    expect(result).toContain("- - Fix ticket permissions");

    // distant unchanged content should NOT appear
    expect(result).not.toContain("Long paragraph");
    expect(result).not.toContain("Another unchanged");
  });
});
