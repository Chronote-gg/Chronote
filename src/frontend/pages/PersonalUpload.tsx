import { useEffect, useMemo, useState } from "react";
import { Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import {
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES,
  PERSONAL_MEDIA_UPLOAD_MAX_BYTES,
} from "../../constants";
import PageHeader from "../components/PageHeader";
import PersonalUploadPanel from "../features/personalUploads/PersonalUploadPanel";
import type { PersonalUploadPanelJob } from "../features/personalUploads/PersonalUploadPanel";
import { trpc } from "../services/trpc";

type SignedUploadPost = {
  url: string;
  fields: Record<string, string>;
};

type UploadPhase = "idle" | "signing" | "uploading" | "submitting";

const PERSONAL_UPLOAD_ACCEPT =
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES.join(",");
const STATUS_POLL_INTERVAL_MS = 5_000;

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
  if (phase === "signing") return "Preparing upload...";
  if (phase === "uploading") return "Uploading media...";
  if (phase === "submitting") return "Starting processing...";
  if (job?.status === "queued") return "Waiting to process uploaded media...";
  if (job?.status === "processing") return "Processing uploaded media...";
  if (job?.status === "complete") return "Processing complete.";
  if (job?.status === "failed") return "Processing failed.";
  return null;
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
  const disabled =
    phase !== "idle" ||
    createUploadIntent.isPending ||
    completeUpload.isPending ||
    job?.status === "queued" ||
    job?.status === "processing";
  const statusLabel = resolveStatusLabel(phase, job);
  const tags = useMemo(() => parseTags(tagsText), [tagsText]);

  useEffect(() => {
    if (!uploadId || job?.status === "complete" || job?.status === "failed") {
      return;
    }
    const timer = window.setInterval(() => {
      void statusQuery.refetch();
    }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [job?.status, statusQuery, uploadId]);

  const submitUpload = async () => {
    if (!file) {
      setErrorMessage("Choose an audio or video file first.");
      return;
    }
    if (!PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES.includes(file.type)) {
      setErrorMessage("Choose a supported audio or video file.");
      return;
    }
    if (file.size > PERSONAL_MEDIA_UPLOAD_MAX_BYTES) {
      setErrorMessage("Media file is too large.");
      return;
    }

    setErrorMessage(null);
    setUploadProgress(0);
    setUploadId(null);
    try {
      setPhase("signing");
      const intent = await createUploadIntent.mutateAsync({
        contentType: file.type,
        fileSize: file.size,
      });
      setUploadId(intent.uploadId);
      setPhase("uploading");
      await uploadFileToSignedPost(intent.upload, file, setUploadProgress);
      setPhase("submitting");
      await completeUpload.mutateAsync({
        uploadId: intent.uploadId,
        key: intent.key,
        uploadToken: intent.uploadToken,
        originalFileName: file.name,
        title: title.trim() || undefined,
        tags: tags.length ? tags : undefined,
      });
      notifications.show({ message: "Upload received. Processing started." });
    } catch (error) {
      setErrorMessage(getUploadErrorMessage(error));
    } finally {
      setPhase("idle");
    }
  };

  const openMeeting = () => {
    if (!job?.meetingGuildId || !job.channelId_timestamp) return;
    navigate({
      to: "/portal/meetings/$serverId/$meetingId",
      params: {
        serverId: job.meetingGuildId,
        meetingId: job.channelId_timestamp,
      },
    });
  };

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
