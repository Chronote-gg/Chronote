import { expect, it } from "@jest/globals";
import { markdownTableCell } from "../../../src/services/announcements/announcementPreviewMarkdown";

it("escapes a backslash before the pipe, so neither cancels the other", () => {
  // Rendered by GFM as the literal text a\|b in a single cell.
  expect(markdownTableCell("a\\|b")).toBe("a\\\\\\|b");
});

it("renders an empty cell as a dash", () => {
  expect(markdownTableCell("")).toBe("-");
});
