export type ImportNotesMode = "replace" | "append";

export type ImportedNotesSource = {
  sourceName?: string;
  sourceUrl?: string;
};

const IMPORTED_NOTES_HEADING = "## Imported notes";

export const normalizeImportedNotes = (notes: string) =>
  notes.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

const normalizeExistingNotesLineEndings = (notes: string) =>
  notes.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const resolveSourceLine = (source?: ImportedNotesSource) => {
  const sourceName = source?.sourceName?.trim();
  const sourceUrl = source?.sourceUrl?.trim();
  if (sourceName && sourceUrl) {
    return `Source: ${sourceName} - ${sourceUrl}`;
  }
  if (sourceName) {
    return `Source: ${sourceName}`;
  }
  if (sourceUrl) {
    return `Source: ${sourceUrl}`;
  }
  return "";
};

const buildImportedSection = (
  importedNotes: string,
  source?: ImportedNotesSource,
) => {
  const sourceLine = resolveSourceLine(source);
  if (!sourceLine) {
    return `${IMPORTED_NOTES_HEADING}\n\n${importedNotes}`;
  }
  return `${IMPORTED_NOTES_HEADING}\n\n${sourceLine}\n\n${importedNotes}`;
};

export const buildImportedMeetingNotes = (params: {
  currentNotes?: string | null;
  importedNotes: string;
  mode: ImportNotesMode;
  source?: ImportedNotesSource;
}) => {
  const importedNotes = normalizeImportedNotes(params.importedNotes);
  if (params.mode === "replace") {
    return importedNotes;
  }

  const currentNotes = normalizeExistingNotesLineEndings(
    params.currentNotes ?? "",
  );
  const importedSection = buildImportedSection(importedNotes, params.source);
  if (currentNotes.trim().length === 0) {
    return importedSection;
  }
  const separator = currentNotes.endsWith("\n") ? "\n" : "\n\n";
  return `${currentNotes}${separator}${importedSection}`;
};
