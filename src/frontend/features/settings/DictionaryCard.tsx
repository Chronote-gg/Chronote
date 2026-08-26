import { useMemo, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  LoadingOverlay,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
} from "@mantine/core";
import {
  IconBook,
  IconPencil,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import { uiOverlays } from "../../uiTokens";
import type { DictionaryEntry } from "../../../types/db";
import {
  buildDictionaryPromptLines,
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  type DictionaryBudgets,
} from "../../../utils/dictionary";

type DictionaryCardProps = {
  busy: boolean;
  entries: DictionaryEntry[];
  budgets: DictionaryBudgets;
  onUpsert: (term: string, definition?: string) => Promise<void>;
  onRemove: (term: string) => Promise<void>;
  onClear: () => Promise<void>;
  onTeach: () => void;
};

export function DictionaryCard({
  busy,
  entries,
  budgets,
  onUpsert,
  onRemove,
  onClear,
  onTeach,
}: DictionaryCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [showDefinition, setShowDefinition] = useState(false);

  const usage = useMemo(
    () => buildDictionaryPromptLines(entries, budgets).usage,
    [entries, budgets],
  );

  const openEdit = (entry: DictionaryEntry) => {
    setTerm(entry.term);
    setDefinition(entry.definition ?? "");
    setShowDefinition(Boolean(entry.definition));
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
  };

  const handleSave = async () => {
    const trimmedTerm = term.trim();
    if (!trimmedTerm) return;
    const trimmedDefinition = definition.trim();
    const nextDefinition =
      showDefinition && trimmedDefinition.length > 0
        ? trimmedDefinition
        : undefined;
    await onUpsert(trimmedTerm, nextDefinition);
    closeModal();
  };

  const canSave = term.trim().length > 0;

  return (
    <Surface
      p="lg"
      style={{ position: "relative", overflow: "hidden" }}
      data-testid="settings-dictionary"
    >
      <LoadingOverlay
        visible={busy}
        data-testid="settings-loading-dictionary"
        overlayProps={uiOverlays.loading}
        loaderProps={{ size: "md" }}
      />
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Group gap="sm">
            <ThemeIcon variant="light" color="brand">
              <IconBook size={18} />
            </ThemeIcon>
            <Text fw={600}>Teach Chronote</Text>
          </Group>
          <Group gap="sm">
            {entries.length > 0 ? (
              <Button
                variant="subtle"
                color="red"
                onClick={onClear}
                disabled={busy}
              >
                Clear all
              </Button>
            ) : null}
            <Button
              leftSection={<IconSparkles size={16} />}
              onClick={onTeach}
              disabled={busy}
            >
              Teach Chronote
            </Button>
          </Group>
        </Group>

        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            Entries in dictionary: {usage.totalEntries}. Prompts use up to{" "}
            {budgets.maxEntries} most recent entries.
          </Text>
          <Text size="xs" c="dimmed">
            Transcription prompt: {usage.transcription.entries} entries,{" "}
            {usage.transcription.chars}/{budgets.maxCharsTranscription} chars.
          </Text>
          <Text size="xs" c="dimmed">
            Context prompts: {usage.context.entries} entries,{" "}
            {usage.context.chars}/{budgets.maxCharsContext} chars.
          </Text>
        </Stack>

        {entries.length === 0 ? (
          <Surface tone="soft" p="md">
            <Text c="dimmed" size="sm">
              Describe the names, acronyms, and specialized terms Chronote
              should recognize. You will review every term before it is saved.
            </Text>
          </Surface>
        ) : (
          <Stack gap="xs">
            {entries.map((entry) => (
              <Surface key={entry.termKey} p="sm" withBorder>
                <Group justify="space-between" align="center" wrap="nowrap">
                  <Stack gap={2}>
                    <Text fw={600}>{entry.term}</Text>
                    <Text size="xs" c="dimmed">
                      {entry.definition ? entry.definition : "No definition"}
                    </Text>
                  </Stack>
                  <Group gap="xs">
                    <ActionIcon
                      variant="subtle"
                      onClick={() => openEdit(entry)}
                      aria-label="Edit dictionary entry"
                    >
                      <IconPencil size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => onRemove(entry.term)}
                      aria-label="Remove dictionary entry"
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Surface>
            ))}
          </Stack>
        )}
      </Stack>

      <Modal
        opened={modalOpen}
        onClose={closeModal}
        title="Edit dictionary entry"
        overlayProps={uiOverlays.modal}
        data-testid="dictionary-modal"
      >
        <Stack gap="sm">
          <TextInput
            label="Term"
            placeholder="Add a word or phrase"
            value={term}
            onChange={(event) => setTerm(event.currentTarget.value)}
            maxLength={DICTIONARY_TERM_MAX_LENGTH}
          />
          {showDefinition ? (
            <Stack gap={4}>
              <Textarea
                label="Description (optional)"
                minRows={3}
                placeholder="Add a short definition"
                value={definition}
                onChange={(event) => setDefinition(event.currentTarget.value)}
                maxLength={DICTIONARY_DEFINITION_MAX_LENGTH}
              />
              <Button
                variant="subtle"
                color="red"
                onClick={() => {
                  setDefinition("");
                  setShowDefinition(false);
                }}
              >
                Remove definition
              </Button>
            </Stack>
          ) : (
            <Button variant="subtle" onClick={() => setShowDefinition(true)}>
              Add definition
            </Button>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={closeModal}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!canSave || busy}>
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Surface>
  );
}
