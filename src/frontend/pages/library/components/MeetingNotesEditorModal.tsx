import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import Delta from "quill-delta";

type QuillDeltaLike = {
  ops: unknown[];
};

const isQuillDeltaLike = (value: unknown): value is QuillDeltaLike => {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { ops?: unknown };
  return Array.isArray(maybe.ops);
};

const ensureTrailingNewline = (value: string) =>
  value.endsWith("\n") ? value : `${value}\n`;

const buildPlainDeltaFromMarkdown = (markdown: string): Delta =>
  new Delta([
    {
      insert: ensureTrailingNewline(markdown.replace(/\r/g, "")),
    },
  ]);

type MeetingNotesEditorModalProps = {
  opened: boolean;
  initialMarkdown: string;
  initialDelta?: unknown | null;
  saving: boolean;
  onClose: () => void;
  onSave: (delta: unknown) => void;
};

const DEFAULT_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ indent: "-1" }, { indent: "+1" }],
    ["blockquote", "code-block"],
    ["link"],
    ["clean"],
  ],
};

export default function MeetingNotesEditorModal({
  opened,
  initialMarkdown,
  initialDelta,
  saving,
  onClose,
  onSave,
}: MeetingNotesEditorModalProps) {
  const resolvedInitialDelta = useMemo(() => {
    if (isQuillDeltaLike(initialDelta)) {
      return new Delta(initialDelta as unknown as { ops: never[] });
    }
    return buildPlainDeltaFromMarkdown(initialMarkdown);
  }, [initialDelta, initialMarkdown]);

  const [value, setValue] = useState<Delta>(resolvedInitialDelta);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setValue(resolvedInitialDelta);
    setDirty(false);
  }, [opened, resolvedInitialDelta]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Edit notes"
      centered
      size="xl"
      closeOnEscape={!saving}
      closeOnClickOutside={!saving}
      withCloseButton={!saving}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          These edits will be saved as rich text and sent to Discord as
          Markdown.
        </Text>

        <ReactQuill
          theme="snow"
          value={value}
          onChange={(
            _content: string,
            _delta: unknown,
            _source: string,
            editor: { getContents: () => unknown },
          ) => {
            const contents = editor.getContents();
            setValue(
              isQuillDeltaLike(contents)
                ? new Delta(contents as unknown as { ops: never[] })
                : buildPlainDeltaFromMarkdown(initialMarkdown),
            );
            setDirty(true);
          }}
          modules={DEFAULT_MODULES}
          style={{ minHeight: 260 }}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            color="brand"
            onClick={() => onSave({ ops: value.ops })}
            disabled={!dirty || saving}
            loading={saving}
          >
            Save notes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
