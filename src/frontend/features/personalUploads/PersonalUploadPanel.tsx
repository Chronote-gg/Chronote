import {
  Alert,
  Badge,
  Button,
  Group,
  Progress,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconUpload,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";

export type PersonalUploadStatus =
  | "pending_upload"
  | "queued"
  | "processing"
  | "complete"
  | "failed";

export type PersonalUploadPanelJob = {
  status: PersonalUploadStatus;
  errorMessage?: string;
  meetingGuildId?: string;
  channelId_timestamp?: string;
};

export type PersonalUploadPanelProps = {
  accept: string;
  disabled?: boolean;
  errorMessage?: string | null;
  file: File | null;
  job?: PersonalUploadPanelJob | null;
  onFileChange: (file: File | null) => void;
  onOpenMeeting?: () => void;
  onSubmit: () => void;
  onTagsTextChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  statusLabel?: string | null;
  tagsText: string;
  title: string;
  uploadProgress: number;
};

const canOpenMeeting = (job?: PersonalUploadPanelJob | null) =>
  job?.status === "complete" &&
  Boolean(job.meetingGuildId && job.channelId_timestamp);

const canSubmitUpload = (
  file: File | null,
  job?: PersonalUploadPanelJob | null,
) => {
  if (!file) return false;
  return job?.status !== "queued" && job?.status !== "processing";
};

export function PersonalUploadPanel({
  accept,
  disabled = false,
  errorMessage,
  file,
  job,
  onFileChange,
  onOpenMeeting,
  onSubmit,
  onTagsTextChange,
  onTitleChange,
  statusLabel,
  tagsText,
  title,
  uploadProgress,
}: PersonalUploadPanelProps) {
  const openMeetingAvailable = canOpenMeeting(job);
  const submitAvailable = canSubmitUpload(file, job);

  return (
    <Surface p="lg" tone="soft" data-testid="personal-upload-panel">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4} maw={640}>
            <Group gap="xs">
              <Text fw={700}>Upload audio or video</Text>
              <Badge color="brand" variant="light">
                Personal
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Chronote will transcribe the media, generate notes, and save the
              result in My Meetings under your personal workspace.
            </Text>
          </Stack>
          <Button
            component="label"
            variant="light"
            color="brand"
            leftSection={<IconUpload size={16} />}
            disabled={disabled}
            data-testid="personal-upload-choose-file"
          >
            Choose file
            <input
              hidden
              type="file"
              accept={accept}
              disabled={disabled}
              onChange={(event) =>
                onFileChange(event.currentTarget.files?.[0] ?? null)
              }
              data-testid="personal-upload-file-input"
            />
          </Button>
        </Group>

        {file ? (
          <Alert color="blue" variant="light">
            <Text size="sm" fw={600}>
              {file.name}
            </Text>
            <Text size="xs" c="dimmed">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </Text>
          </Alert>
        ) : null}

        <TextInput
          label="Title"
          description="Optional, used as the initial meeting name."
          placeholder="Planning call, customer interview, class lecture..."
          value={title}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
          disabled={disabled}
          data-testid="personal-upload-title"
        />
        <TextInput
          label="Tags"
          description="Optional comma-separated labels."
          placeholder="planning, research, lecture"
          value={tagsText}
          onChange={(event) => onTagsTextChange(event.currentTarget.value)}
          disabled={disabled}
          data-testid="personal-upload-tags"
        />

        {statusLabel ? (
          <Stack gap={6}>
            <Group justify="space-between" gap="sm">
              <Text size="sm" fw={600}>
                {statusLabel}
              </Text>
              {uploadProgress > 0 && uploadProgress < 100 ? (
                <Text size="xs" c="dimmed">
                  {uploadProgress}%
                </Text>
              ) : null}
            </Group>
            {uploadProgress > 0 && uploadProgress < 100 ? (
              <Progress value={uploadProgress} color="brand" />
            ) : null}
          </Stack>
        ) : null}

        {errorMessage || job?.errorMessage ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            data-testid="personal-upload-error"
          >
            {errorMessage ?? job?.errorMessage}
          </Alert>
        ) : null}

        {job?.status === "complete" ? (
          <Alert
            color="teal"
            variant="light"
            icon={<IconCheck size={16} />}
            data-testid="personal-upload-complete"
          >
            Your personal meeting is ready.
          </Alert>
        ) : null}

        <Group justify="flex-end">
          {openMeetingAvailable ? (
            <Button
              variant="light"
              color="brand"
              rightSection={<IconExternalLink size={16} />}
              onClick={onOpenMeeting}
              data-testid="personal-upload-open-meeting"
            >
              Open meeting
            </Button>
          ) : null}
          <Button
            onClick={onSubmit}
            loading={disabled}
            disabled={!submitAvailable}
            leftSection={<IconUpload size={16} />}
            data-testid="personal-upload-submit"
          >
            Upload and process
          </Button>
        </Group>
      </Stack>
    </Surface>
  );
}

export default PersonalUploadPanel;
