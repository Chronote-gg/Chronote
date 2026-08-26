import { useEffect, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import type { AppRouter } from "../../../trpc/router";
import {
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
} from "../../../utils/dictionary";
import { DICTIONARY_TEACHING_INPUT_MAX_LENGTH } from "../../../types/dictionaryTeaching";
import { trpc } from "../../services/trpc";
import Surface from "../../components/Surface";
import { uiOverlays } from "../../uiTokens";

type RouterOutput = inferRouterOutputs<AppRouter>;
type TeachingDraft =
  RouterOutput["dictionary"]["previewTeaching"]["drafts"][number];

type EditableDraft = TeachingDraft & {
  included: boolean;
  preferredTermInput: string;
  descriptionInput: string;
};

type DictionaryTeachingModalProps = {
  opened: boolean;
  serverId: string;
  initialInstruction?: string;
  correctionContextToken?: string;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
};

const actionLabel = (draft: EditableDraft) => {
  if (draft.action === "update")
    return { label: "Updates existing", color: "blue" };
  if (draft.action === "conflict")
    return { label: "Possible conflict", color: "yellow" };
  if (draft.action === "needs_input")
    return { label: "Needs exact spelling", color: "orange" };
  return { label: "New term", color: "green" };
};

export default function DictionaryTeachingModal({
  opened,
  serverId,
  initialInstruction = "",
  correctionContextToken,
  onClose,
  onSaved,
}: DictionaryTeachingModalProps) {
  const [instruction, setInstruction] = useState(initialInstruction);
  const [token, setToken] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const previewMutation = trpc.dictionary.previewTeaching.useMutation();
  const commitMutation = trpc.dictionary.commitTeaching.useMutation();

  useEffect(() => {
    if (!opened) return;
    setInstruction(initialInstruction);
    setToken(null);
    setDrafts([]);
  }, [initialInstruction, opened]);

  const selectedDrafts = useMemo(
    () =>
      drafts.filter(
        (draft) => draft.included && draft.preferredTermInput.trim().length > 0,
      ),
    [drafts],
  );

  const updateDraft = (draftId: string, update: Partial<EditableDraft>) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.draftId === draftId ? { ...draft, ...update } : draft,
      ),
    );
  };

  const analyze = async () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    try {
      const result = await previewMutation.mutateAsync({
        serverId,
        instruction: trimmed,
        correctionContextToken,
      });
      setToken(result.token);
      setDrafts(
        result.drafts.map((draft) => ({
          ...draft,
          included:
            draft.action !== "conflict" && draft.action !== "needs_input",
          preferredTermInput: draft.preferredTerm ?? "",
          descriptionInput: draft.description ?? "",
        })),
      );
    } catch (error) {
      console.error("Failed to analyze dictionary teaching request", error);
      notifications.show({
        color: "red",
        message:
          "Chronote could not review that request. Check the wording and try again.",
      });
    }
  };

  const commit = async () => {
    if (!token || selectedDrafts.length === 0) return;
    try {
      const result = await commitMutation.mutateAsync({
        serverId,
        token,
        entries: selectedDrafts.map((draft) => ({
          draftId: draft.draftId,
          preferredTerm: draft.preferredTermInput.trim(),
          observedForms: draft.observedForms,
          description: draft.descriptionInput.trim(),
        })),
      });
      const failures = result.results.filter((item) => !item.ok);
      if (failures.length > 0) {
        notifications.show({
          color: "red",
          message:
            failures[0].error ??
            `${failures.length} term${failures.length === 1 ? "" : "s"} could not be saved. Review and try again.`,
        });
        return;
      }
      await onSaved?.();
      notifications.show({
        message: `Chronote learned ${result.results.length} term${result.results.length === 1 ? "" : "s"}.`,
      });
      onClose();
    } catch (error) {
      console.error("Failed to save dictionary teaching drafts", error);
      notifications.show({
        color: "red",
        message: "Those terms could not be saved. Review them and try again.",
      });
    }
  };

  const reviewing = token !== null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Teach Chronote"
      size="lg"
      centered
      overlayProps={uiOverlays.modal}
      data-testid="dictionary-teaching-modal"
    >
      {!reviewing ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Describe the exact names, acronyms, or specialized terms Chronote
            should recognize. You will review every term before it is saved.
          </Text>
          <Textarea
            label="What should Chronote learn?"
            description="For example: “It wrote John Smith, but his name is Jon Smythe. He works with us on Apollo.”"
            placeholder="Tell Chronote what it got wrong and the exact spelling it should use."
            minRows={6}
            autosize
            maxRows={12}
            maxLength={DICTIONARY_TEACHING_INPUT_MAX_LENGTH}
            value={instruction}
            onChange={(event) => setInstruction(event.currentTarget.value)}
            disabled={previewMutation.isPending}
            data-testid="dictionary-teaching-input"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              leftSection={<IconSparkles size={16} />}
              onClick={analyze}
              loading={previewMutation.isPending}
              disabled={!instruction.trim()}
            >
              Review terms
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Confirm the exact spelling and description. Unchecked entries will
            not be added to the dictionary.
          </Text>
          <ScrollArea.Autosize
            mah="55vh"
            offsetScrollbars
            type="auto"
            data-testid="dictionary-teaching-review-scroll"
          >
            <Stack gap="sm" pr="xs">
              {drafts.map((draft) => {
                const action = actionLabel(draft);
                return (
                  <Surface key={draft.draftId} p="md" withBorder>
                    <Stack gap="sm">
                      <Group justify="space-between" align="flex-start">
                        <Checkbox
                          label="Save this term"
                          checked={draft.included}
                          onChange={(event) =>
                            updateDraft(draft.draftId, {
                              included: event.currentTarget.checked,
                            })
                          }
                        />
                        <Badge color={action.color} variant="light">
                          {action.label}
                        </Badge>
                      </Group>
                      {draft.ambiguity ? (
                        <Alert
                          color="yellow"
                          icon={<IconAlertTriangle size={16} />}
                          py="xs"
                        >
                          {draft.ambiguity}
                        </Alert>
                      ) : null}
                      <TextInput
                        label="Exact spelling"
                        value={draft.preferredTermInput}
                        maxLength={DICTIONARY_TERM_MAX_LENGTH}
                        onChange={(event) =>
                          updateDraft(draft.draftId, {
                            preferredTermInput: event.currentTarget.value,
                          })
                        }
                      />
                      <Textarea
                        label="Description (optional)"
                        description="Used as context when Chronote cleans transcripts and writes notes."
                        value={draft.descriptionInput}
                        minRows={2}
                        autosize
                        maxRows={5}
                        maxLength={DICTIONARY_DEFINITION_MAX_LENGTH}
                        onChange={(event) =>
                          updateDraft(draft.draftId, {
                            descriptionInput: event.currentTarget.value,
                          })
                        }
                      />
                      {draft.observedForms.length > 0 ? (
                        <Stack gap={4}>
                          <Text size="xs" fw={600}>
                            Chronote previously wrote
                          </Text>
                          <Group gap="xs">
                            {draft.observedForms.map((form) => (
                              <Button
                                key={form}
                                variant="light"
                                size="compact-xs"
                                rightSection={<IconX size={12} />}
                                onClick={() =>
                                  updateDraft(draft.draftId, {
                                    observedForms: draft.observedForms.filter(
                                      (value) => value !== form,
                                    ),
                                  })
                                }
                              >
                                {form}
                              </Button>
                            ))}
                          </Group>
                        </Stack>
                      ) : null}
                      {draft.existingEntry ? (
                        <Text size="xs" c="dimmed">
                          Existing entry: {draft.existingEntry.term}
                          {draft.existingEntry.definition
                            ? `: ${draft.existingEntry.definition}`
                            : ""}
                        </Text>
                      ) : null}
                      {draft.evidence.length > 0 ? (
                        <Text size="xs" c="dimmed">
                          Based on: “{draft.evidence[0].quote}”
                        </Text>
                      ) : null}
                    </Stack>
                  </Surface>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>
          <Group justify="space-between">
            <Button
              variant="subtle"
              leftSection={<IconArrowLeft size={16} />}
              onClick={() => {
                setToken(null);
                setDrafts([]);
              }}
              disabled={commitMutation.isPending}
            >
              Revise request
            </Button>
            <Group gap="sm">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={commit}
                loading={commitMutation.isPending}
                disabled={selectedDrafts.length === 0}
              >
                Teach Chronote
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
