import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Image,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconCheck,
  IconMessageReport,
  IconPhoto,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import Surface from "../components/Surface";
import { trpc } from "../services/trpc";
import {
  CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES,
  CONTACT_FEEDBACK_MAX_IMAGE_BYTES,
  CONTACT_FEEDBACK_MAX_IMAGES,
  CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH,
} from "../../constants";
import { useAuth } from "../contexts/AuthContext";
import { executeRecaptcha, useRecaptchaScript } from "../hooks/useRecaptcha";

const HONEYPOT_FIELD_NAME = "website_url";
const IMAGE_SIZE_LABEL = `${CONTACT_FEEDBACK_MAX_IMAGE_BYTES / (1024 * 1024)}MB`;

/** Upload images to S3 via presigned URLs. Returns uploaded keys and any failures. */
type UploadImagesResult = {
  keys: string[];
  error?: string;
};

const buildUploadFailureMessage = (failedNames: string[]) => {
  const quotedNames = failedNames.map((name) => `"${name}"`).join(", ");
  const label = failedNames.length === 1 ? "image" : "images";
  return `Failed to upload ${quotedNames}. Please retry those ${label} or submit without them.`;
};

async function uploadImagesToS3(
  images: { file: File; previewUrl: string }[],
  getUploadUrl: (input: {
    contentType: (typeof CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES)[number];
  }) => Promise<{ url: string; key: string }>,
): Promise<UploadImagesResult> {
  const keys: string[] = [];
  const failedNames: string[] = [];

  for (const img of images) {
    try {
      const { url, key } = await getUploadUrl({
        contentType: img.file
          .type as (typeof CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES)[number],
      });
      const response = await fetch(url, {
        method: "PUT",
        body: img.file,
        headers: { "Content-Type": img.file.type },
      });
      if (!response.ok) {
        failedNames.push(img.file.name);
        continue;
      }
      keys.push(key);
    } catch {
      failedNames.push(img.file.name);
    }
  }

  if (failedNames.length > 0) {
    return {
      keys,
      error: buildUploadFailureMessage(failedNames),
    };
  }

  return { keys };
}

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "An unexpected error occurred.";
}

type PendingImage = {
  file: File;
  previewUrl: string;
};

export type ContactFeedbackFormProps = {
  isAnonymous: boolean;
  isPending: boolean;
  submitError: { message: string } | null;
  onSubmit: (data: {
    message: string;
    contactEmail?: string;
    contactDiscord?: string;
    honeypot?: string;
    images: PendingImage[];
  }) => void;
};

export function ContactFeedbackForm({
  isAnonymous,
  isPending,
  submitError,
  onSubmit,
}: ContactFeedbackFormProps) {
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactDiscord, setContactDiscord] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke Object URLs on unmount to prevent memory leaks.
  // Only runs cleanup on unmount; image list changes are handled by removeImage.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => {
    return () => {
      imagesRef.current.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, []);

  const canSubmit =
    message.trim().length > 0 &&
    message.length <= CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH &&
    !isPending;

  const handleFileSelect = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      setUploadError(null);

      const remaining = CONTACT_FEEDBACK_MAX_IMAGES - images.length;
      const newFiles = Array.from(fileList).slice(0, remaining);

      const validFiles: File[] = [];
      const errors: string[] = [];
      for (const file of newFiles) {
        if (!CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES.includes(file.type)) {
          errors.push(
            `"${file.name}" is not a supported image type. Use PNG, JPEG, GIF, or WebP.`,
          );
          continue;
        }
        if (file.size > CONTACT_FEEDBACK_MAX_IMAGE_BYTES) {
          errors.push(
            `"${file.name}" exceeds the ${IMAGE_SIZE_LABEL} size limit.`,
          );
          continue;
        }
        validFiles.push(file);
      }
      if (errors.length > 0) setUploadError(errors.join(" "));

      const pending: PendingImage[] = validFiles.map((file) => ({
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      setImages((prev) => [...prev, ...pending]);
    },
    [images.length],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setUploadError(null);
    onSubmit({
      message: message.trim(),
      contactEmail: contactEmail.trim() || undefined,
      contactDiscord: contactDiscord.trim() || undefined,
      honeypot: honeypot || undefined,
      images,
    });
  };

  return (
    <Stack gap="lg" data-testid="contact-feedback-page">
      <Stack gap={4}>
        <Group gap="xs" align="center">
          <IconMessageReport size={28} />
          <Title order={2}>Send us feedback</Title>
        </Group>
        <Text size="sm" c="dimmed">
          Bug reports, feature requests, or general feedback. We read every
          submission.
        </Text>
      </Stack>

      <Surface tone="raised" p="lg">
        <form
          data-testid="contact-feedback-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <Stack gap="md">
            <Textarea
              label="Your feedback"
              placeholder="Tell us what's on your mind..."
              required
              autosize
              minRows={4}
              maxRows={12}
              maxLength={CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH}
              value={message}
              onChange={(e) => setMessage(e.currentTarget.value)}
              data-testid="contact-feedback-message"
              description={`${message.length}/${CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH}`}
            />

            {isAnonymous && (
              <>
                <TextInput
                  label="Email (optional)"
                  placeholder="you@example.com"
                  description="So we can follow up if needed"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.currentTarget.value)}
                  data-testid="contact-feedback-email"
                />

                <TextInput
                  label="Discord username (optional)"
                  placeholder="username#1234"
                  description="We may reach out on Discord"
                  value={contactDiscord}
                  onChange={(e) => setContactDiscord(e.currentTarget.value)}
                  data-testid="contact-feedback-discord"
                />
              </>
            )}

            {/* Image attachments */}
            <Stack gap="xs">
              <Group gap="xs" align="center">
                <Text size="sm" fw={500}>
                  Screenshots (optional)
                </Text>
                <Text size="xs" c="dimmed">
                  Up to {CONTACT_FEEDBACK_MAX_IMAGES} images, {IMAGE_SIZE_LABEL}{" "}
                  each
                </Text>
              </Group>

              {images.length > 0 && (
                <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
                  {images.map((img, index) => (
                    <Paper
                      key={img.previewUrl}
                      pos="relative"
                      radius="sm"
                      withBorder
                      p={4}
                    >
                      <Image
                        src={img.previewUrl}
                        alt={img.file.name}
                        h={100}
                        fit="cover"
                        radius="sm"
                      />
                      <ActionIcon
                        size="xs"
                        color="red"
                        variant="filled"
                        pos="absolute"
                        top={4}
                        right={4}
                        onClick={() => removeImage(index)}
                        aria-label={`Remove ${img.file.name}`}
                        data-testid={`contact-feedback-remove-image-${index}`}
                      >
                        <IconX size={10} />
                      </ActionIcon>
                      <Text size="xs" c="dimmed" truncate mt={2}>
                        {img.file.name}
                      </Text>
                    </Paper>
                  ))}
                </SimpleGrid>
              )}

              {images.length < CONTACT_FEEDBACK_MAX_IMAGES && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES.join(",")}
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      handleFileSelect(e.target.files);
                      e.target.value = "";
                    }}
                    data-testid="contact-feedback-file-input"
                  />
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconPhoto size={14} />}
                    onClick={() => fileInputRef.current?.click()}
                    w="fit-content"
                    data-testid="contact-feedback-add-images"
                  >
                    Add screenshots
                  </Button>
                </>
              )}

              {uploadError && (
                <Alert
                  color="orange"
                  variant="light"
                  icon={<IconTrash size={14} />}
                >
                  {uploadError}
                </Alert>
              )}
            </Stack>

            {/* Honeypot field, hidden from real users */}
            <div
              style={{ position: "absolute", left: "-9999px" }}
              aria-hidden="true"
            >
              <TextInput
                label={HONEYPOT_FIELD_NAME}
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.currentTarget.value)}
              />
            </div>

            {submitError && (
              <Alert color="red" variant="light">
                Something went wrong. Please try again.
              </Alert>
            )}

            <Group justify="flex-end">
              <Button
                type="submit"
                leftSection={<IconSend size={16} />}
                disabled={!canSubmit}
                loading={isPending}
                data-testid="contact-feedback-submit"
              >
                Send feedback
              </Button>
            </Group>
          </Stack>
        </form>
      </Surface>
    </Stack>
  );
}

function ContactFeedbackSuccess() {
  return (
    <Stack gap="lg" data-testid="contact-feedback-page">
      <Alert
        icon={<IconCheck size={16} />}
        color="teal"
        variant="light"
        data-testid="contact-feedback-success"
      >
        <Title order={4}>Thank you for your feedback!</Title>
        <Text size="sm" mt="xs">
          We appreciate you taking the time to share your thoughts. If you left
          contact info, we may follow up with you directly.
        </Text>
      </Alert>
    </Stack>
  );
}

export default function ContactFeedback() {
  const { user } = useAuth();
  const [submitted, setSubmitted] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<{ message: string } | null>(
    null,
  );

  const recaptchaReady = useRecaptchaScript();
  const submitMutation = trpc.contactFeedback.submit.useMutation();
  const getUploadUrlMutation = trpc.contactFeedback.getUploadUrl.useMutation();

  const handleFormSubmit = async (data: {
    message: string;
    contactEmail?: string;
    contactDiscord?: string;
    honeypot?: string;
    images: { file: File; previewUrl: string }[];
  }) => {
    setUploadError(null);
    setIsUploading(true);
    try {
      const recaptchaToken =
        !user && recaptchaReady
          ? await executeRecaptcha("submit_feedback")
          : undefined;

      const uploadResult = await uploadImagesToS3(
        data.images,
        getUploadUrlMutation.mutateAsync,
      );
      if (uploadResult.error && uploadResult.keys.length === 0) {
        setUploadError({ message: uploadResult.error });
        return;
      }

      await submitMutation.mutateAsync({
        message: data.message,
        contactEmail: data.contactEmail,
        contactDiscord: data.contactDiscord,
        honeypot: data.honeypot,
        recaptchaToken,
        imageS3Keys:
          uploadResult.keys.length > 0 ? uploadResult.keys : undefined,
      });

      data.images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setSubmitted(true);
    } catch (err) {
      setUploadError({ message: extractErrorMessage(err) });
    } finally {
      setIsUploading(false);
    }
  };

  if (submitted) {
    return <ContactFeedbackSuccess />;
  }

  const isBusy =
    isUploading || submitMutation.isPending || getUploadUrlMutation.isPending;

  return (
    <ContactFeedbackForm
      isAnonymous={!user}
      isPending={isBusy}
      submitError={uploadError ?? submitMutation.error}
      onSubmit={(data) => void handleFormSubmit(data)}
    />
  );
}
