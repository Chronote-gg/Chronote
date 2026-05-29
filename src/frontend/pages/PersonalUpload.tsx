import { useEffect, useState } from "react";
import { Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import {
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES,
  PERSONAL_MEDIA_UPLOAD_MAX_BYTES,
} from "../../constants";
import PageHeader from "../components/PageHeader";
import PersonalUploadPanel from "../features/personalUploads/PersonalUploadPanel";
import type {
  PersonalUploadPanelJob,
  PersonalUploadStatus,
} from "../features/personalUploads/PersonalUploadPanel";
import { trpc } from "../services/trpc";

type SignedUploadPost = {
  url: string;
  fields: Record<string, string>;
};

type UploadPhase = "idle" | "signing" | "uploading" | "submitting";

type CreateUploadIntentMutation = {
  isPending: boolean;
  mutateAsync: (input: { contentType: string; fileSize: number }) => Promise<{
    uploadId: string;
    key: string;
    uploadToken: string;
    upload: SignedUploadPost;
  }>;
};

type CompleteUploadMutation = {
  data?: { job?: PersonalUploadPanelJob | null } | null;
  isPending: boolean;
  mutateAsync: (input: {
    uploadId: string;
    key: string;
    uploadToken: string;
    originalFileName: string;
    title?: string;
    tags?: string[];
  }) => Promise<unknown>;
};

type PersonalMeetingNavigate = (options: {
  to: "/portal/meetings/$serverId/$meetingId";
  params: { serverId: string; meetingId: string };
}) => void;

const PERSONAL_UPLOAD_ACCEPT =
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES.join(",");
const STATUS_POLL_INTERVAL_MS = 5_000;
const BLOCKING_JOB_STATUSES = new Set<PersonalUploadStatus>([
  "queued",
  "processing",
]);
const PHASE_STATUS_LABELS: Partial<Record<UploadPhase, string>> = {
  signing: "Preparing upload...",
  uploading: "Uploading media...",
  submitting: "Starting processing...",
};
const JOB_STATUS_LABELS: Partial<Record<PersonalUploadStatus, string>> = {
  queued: "Waiting to process uploaded media...",
  processing: "Processing uploaded media...",
  complete: "Processing complete.",
  failed: "Processing failed.",
};

const parseTags = (tagsText: string) =>
  tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);

const resolveStatusLabel = (
  phase: UploadPhase,
  job?: PersonalUploadPanelJob | null,
) => {
  if (phase !== "idle") return PHASE_STATUS_LABELS[phase] ?? null;
  return job ? (JOB_STATUS_LABELS[job.status] ?? null) : null;
};

const uploadFileToSignedPost = (
  post: SignedUploadPost,
  file: File,
  onProgress: (progress: number) => void,
) =>
  new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error("Upload failed. Please retry."));
    };
    request.onerror = () => reject(new Error("Upload failed. Please retry."));
    request.onabort = () => reject(new Error("Upload was canceled."));

    const formData = new FormData();
    Object.entries(post.fields).forEach(([key, value]) => {
      formData.append(key, value);
    });
    formData.append("file", file);
    request.open("POST", post.url);
    request.send(formData);
  });

const getUploadErrorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Upload failed. Please retry.";

const validateUploadFile = (file: File | null) => {
  if (!file) return "Choose an audio or video file first.";
  if (!PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES.includes(file.type)) {
    return "Choose a supported audio or video file.";
  }
  if (file.size > PERSONAL_MEDIA_UPLOAD_MAX_BYTES) {
    return "Media file is too large.";
  }
  return null;
};

const isUploadDisabled = (
  phase: UploadPhase,
  createUploadPending: boolean,
  completeUploadPending: boolean,
  job?: PersonalUploadPanelJob | null,
) =>
  phase !== "idle" ||
  createUploadPending ||
  completeUploadPending ||
  Boolean(job && BLOCKING_JOB_STATUSES.has(job.status));

const shouldPollUploadStatus = (status?: PersonalUploadStatus) =>
  Boolean(status && status !== "complete" && status !== "failed");

function useUploadStatusPolling(
  uploadId: string | null,
  status: PersonalUploadStatus | undefined,
  refetch: () => unknown,
) {
  useEffect(() => {
    if (!uploadId || !shouldPollUploadStatus(status)) return;

    const timer = window.setInterval(() => {
      void refetch();
    }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refetch, status, uploadId]);
}

async function submitPersonalUpload(input: {
  completeUpload: CompleteUploadMutation;
  createUploadIntent: CreateUploadIntentMutation;
  file: File | null;
  setErrorMessage: (message: string | null) => void;
  setPhase: (phase: UploadPhase) => void;
  setUploadId: (uploadId: string | null) => void;
  setUploadProgress: (progress: number) => void;
  tagsText: string;
  title: string;
}) {
  const file = input.file;
  const validationMessage = validateUploadFile(file);
  if (validationMessage) {
    input.setErrorMessage(validationMessage);
    return;
  }
  if (!file) return;

  input.setErrorMessage(null);
  input.setUploadProgress(0);
  input.setUploadId(null);
  try {
    input.setPhase("signing");
    const intent = await input.createUploadIntent.mutateAsync({
      contentType: file.type,
      fileSize: file.size,
    });
    input.setUploadId(intent.uploadId);
    input.setPhase("uploading");
    await uploadFileToSignedPost(intent.upload, file, input.setUploadProgress);
    input.setPhase("submitting");
    const tags = parseTags(input.tagsText);
    await input.completeUpload.mutateAsync({
      uploadId: intent.uploadId,
      key: intent.key,
      uploadToken: intent.uploadToken,
      originalFileName: file.name,
      title: input.title.trim() || undefined,
      tags: tags.length ? tags : undefined,
    });
    notifications.show({ message: "Upload received. Processing started." });
  } catch (error) {
    input.setErrorMessage(getUploadErrorMessage(error));
  } finally {
    input.setPhase("idle");
  }
}

function openPersonalMeeting(
  navigate: PersonalMeetingNavigate,
  job?: PersonalUploadPanelJob | null,
) {
  if (!job?.meetingGuildId || !job.channelId_timestamp) return;
  navigate({
    to: "/portal/meetings/$serverId/$meetingId",
    params: {
      serverId: job.meetingGuildId,
      meetingId: job.channelId_timestamp,
    },
  });
}

export default function PersonalUpload() {
  const navigate = useNavigate({ from: "/portal/upload" });
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const createUploadIntent =
    trpc.personalUploads.createUploadIntent.useMutation();
  const completeUpload = trpc.personalUploads.completeUpload.useMutation();
  const statusQuery = trpc.personalUploads.getStatus.useQuery(
    { uploadId: uploadId ?? "" },
    { enabled: Boolean(uploadId) },
  );

  const job = statusQuery.data?.job ?? completeUpload.data?.job ?? null;
  const disabled = isUploadDisabled(
    phase,
    createUploadIntent.isPending,
    completeUpload.isPending,
    job,
  );
  const statusLabel = resolveStatusLabel(phase, job);
  useUploadStatusPolling(uploadId, job?.status, statusQuery.refetch);

  const submitUpload = () =>
    void submitPersonalUpload({
      completeUpload,
      createUploadIntent,
      file,
      setErrorMessage,
      setPhase,
      setUploadId,
      setUploadProgress,
      tagsText,
      title,
    });

  const openMeeting = () => openPersonalMeeting(navigate, job);

  return (
    <Stack gap="lg" data-testid="personal-upload-page">
      <PageHeader
        title="Upload Media"
        description="Create a personal Chronote meeting from an audio or video file."
      />
      <PersonalUploadPanel
        accept={PERSONAL_UPLOAD_ACCEPT}
        disabled={disabled}
        errorMessage={errorMessage}
        file={file}
        job={job}
        onFileChange={setFile}
        onOpenMeeting={openMeeting}
        onSubmit={submitUpload}
        onTagsTextChange={setTagsText}
        onTitleChange={setTitle}
        statusLabel={statusLabel}
        tagsText={tagsText}
        title={title}
        uploadProgress={uploadProgress}
      />
    </Stack>
  );
}
