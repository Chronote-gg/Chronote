import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { IconCheck, IconMessageReport, IconSend } from "@tabler/icons-react";
import Surface from "../components/Surface";
import { trpc } from "../services/trpc";
import { CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH } from "../../constants";
import { useAuth } from "../contexts/AuthContext";

const HONEYPOT_FIELD_NAME = "website_url";

export default function ContactFeedback() {
  const { user } = useAuth();
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactDiscord, setContactDiscord] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submitMutation = trpc.contactFeedback.submit.useMutation();

  const canSubmit =
    message.trim().length > 0 &&
    message.length <= CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH &&
    !submitMutation.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    try {
      await submitMutation.mutateAsync({
        message: message.trim(),
        contactEmail: contactEmail.trim() || undefined,
        contactDiscord: contactDiscord.trim() || undefined,
        honeypot: honeypot || undefined,
      });
      setSubmitted(true);
    } catch {
      // Error state handled by submitMutation.error in the UI
    }
  };

  if (submitted) {
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
            We appreciate you taking the time to share your thoughts. If you
            left contact info, we may follow up with you directly.
          </Text>
        </Alert>
      </Stack>
    );
  }

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
            void handleSubmit();
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

            {!user && (
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

            {submitMutation.error && (
              <Alert color="red" variant="light">
                Something went wrong. Please try again.
              </Alert>
            )}

            <Group justify="flex-end">
              <Button
                type="submit"
                leftSection={<IconSend size={16} />}
                disabled={!canSubmit}
                loading={submitMutation.isPending}
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
