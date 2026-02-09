export const NOTES_HISTORY_ENTRY_CHAR_LIMIT = 8_000;

export function trimNotesForHistory(notes: string): string {
  if (notes.length <= NOTES_HISTORY_ENTRY_CHAR_LIMIT) return notes;
  return `${notes.slice(0, NOTES_HISTORY_ENTRY_CHAR_LIMIT)}\n\n[truncated]`;
}
