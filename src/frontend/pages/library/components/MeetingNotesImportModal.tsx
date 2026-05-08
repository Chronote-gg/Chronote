import {
  Button,
  Group,
  Modal,
  Radio,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";

export type ImportNotesMode = "replace" | "append";

export type ImportNotesPayload = {
  notes: string;
  mode: ImportNotesMode;
  sourceName?: string;
  sourceUrl?: string;
};

type MeetingNotesImportModalProps = {
  opened: boolean;
  saving: boolean;
  onClose: () => void;
  onImport: (payload: ImportNotesPayload) => void;
};

const normalizeOptionalValue = (value: string) => value.trim() || undefined;

const isValidSourceUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const isImportNotesMode = (value: string): value is ImportNotesMode =>
  value === "replace" || value === "append";

export default function MeetingNotesImportModal({
  opened,
  saving,
  onClose,
  onImport,
}: MeetingNotesImportModalProps) {
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<ImportNotesMode>("append");
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    if (!opened) return;
    setNotes("");
    setMode("append");
    setSourceName("");
    setSourceUrl("");
  }, [opened]);

  const trimmedNotes = notes.trim();
  const trimmedSourceUrl = sourceUrl.trim();
  const sourceUrlError =
    trimmedSourceUrl.length > 0 && !isValidSourceUrl(trimmedSourceUrl)
      ? "Enter a valid URL starting with http:// or https://"
      : undefined;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Import notes"
      centered
      size="lg"
      closeOnEscape={!saving}
      closeOnClickOutside={!saving}
      withCloseButton={!saving}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Paste Markdown or plain text from another notes app. Imported notes
          are saved as a new Chronote notes version.
        </Text>

        <Textarea
          label="Notes"
          placeholder="Paste your notes here"
          minRows={10}
          autosize
          value={notes}
          onChange={(event) => setNotes(event.currentTarget.value)}
          disabled={saving}
          required
        />

        <Radio.Group
          label="Import mode"
          value={mode}
          onChange={(value) => {
            if (isImportNotesMode(value)) {
              setMode(value);
            }
          }}
        >
          <Group mt="xs">
            <Radio
              value="append"
              label="Append to current notes"
              disabled={saving}
            />
            <Radio
              value="replace"
              label="Replace current notes"
              disabled={saving}
            />
          </Group>
        </Radio.Group>

        <TextInput
          label="Source name"
          placeholder="Notion, Obsidian, Google Docs"
          value={sourceName}
          onChange={(event) => setSourceName(event.currentTarget.value)}
          disabled={saving}
        />

        <TextInput
          label="Source URL"
          placeholder="https://..."
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.currentTarget.value)}
          error={sourceUrlError}
          disabled={saving}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            color="brand"
            onClick={() =>
              onImport({
                notes: trimmedNotes,
                mode,
                sourceName: normalizeOptionalValue(sourceName),
                sourceUrl: normalizeOptionalValue(sourceUrl),
              })
            }
            disabled={!trimmedNotes || Boolean(sourceUrlError) || saving}
            loading={saving}
          >
            Import notes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
