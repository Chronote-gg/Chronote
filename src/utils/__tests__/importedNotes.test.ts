import {
  buildImportedMeetingNotes,
  normalizeImportedNotes,
} from "../importedNotes";

describe("importedNotes", () => {
  it("normalizes CRLF notes and trims outer whitespace", () => {
    expect(normalizeImportedNotes("\r\n# Notes\r\n- one\r\n")).toBe(
      "# Notes\n- one",
    );
  });

  it("replaces current notes with imported notes", () => {
    expect(
      buildImportedMeetingNotes({
        currentNotes: "Old notes",
        importedNotes: "New notes",
        mode: "replace",
      }),
    ).toBe("New notes");
  });

  it("appends imported notes with source metadata", () => {
    expect(
      buildImportedMeetingNotes({
        currentNotes: "Existing notes",
        importedNotes: "External notes",
        mode: "append",
        source: {
          sourceName: "Notion",
          sourceUrl: "https://example.com/notes",
        },
      }),
    ).toBe(
      "Existing notes\n\n## Imported notes\n\nSource: Notion - https://example.com/notes\n\nExternal notes",
    );
  });

  it("preserves existing notes whitespace when appending", () => {
    expect(
      buildImportedMeetingNotes({
        currentNotes: "  Existing notes\r\n",
        importedNotes: "External notes",
        mode: "append",
      }),
    ).toBe("  Existing notes\n\n## Imported notes\n\nExternal notes");
  });

  it("uses the imported section when append has no current notes", () => {
    expect(
      buildImportedMeetingNotes({
        currentNotes: "",
        importedNotes: "External notes",
        mode: "append",
      }),
    ).toBe("## Imported notes\n\nExternal notes");
  });
});
