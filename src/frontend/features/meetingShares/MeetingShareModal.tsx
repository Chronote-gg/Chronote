import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconLink, IconRefresh } from "@tabler/icons-react";

export type MeetingShareVisibility = "private" | "server" | "public";

type MeetingShareModalProps = {
  opened: boolean;
  onClose: () => void;
  meetingTitle: string;
  sharingEnabled: boolean;
  publicSharingEnabled: boolean;
  visibility: MeetingShareVisibility;
  shareUrl: string;
  shareError: string | null;
  sharePending: boolean;
  onCopyLink: () => void;
  onSetVisibility: (
    visibility: MeetingShareVisibility,
    options?: { acknowledgePublic?: boolean },
  ) => void;
  onRotate: () => void;
  rotatePending: boolean;
};

const resolveToggleLabel = (
  visibility: MeetingShareVisibility,
): { label: string; next: MeetingShareVisibility } | null => {
  if (visibility === "public") {
    return { label: "Make server-only", next: "server" };
  }
  if (visibility === "server") {
    return { label: "Make public", next: "public" };
  }
  return null;
};

export function MeetingShareModal({
  opened,
  onClose,
  meetingTitle,
  sharingEnabled,
  publicSharingEnabled,
  visibility,
  shareUrl,
  shareError,
  sharePending,
  onCopyLink,
  onSetVisibility,
  onRotate,
  rotatePending,
}: MeetingShareModalProps) {
  const [acknowledgePublic, setAcknowledgePublic] = useState(false);

  useEffect(() => {
    if (opened) {
      setAcknowledgePublic(false);
    }
  }, [opened]);

  const isShared = visibility !== "private";
  const toggle = useMemo(
    () => (publicSharingEnabled ? resolveToggleLabel(visibility) : null),
    [visibility, publicSharingEnabled],
  );
  const canMakePublic = publicSharingEnabled && acknowledgePublic;

  const intro = publicSharingEnabled
    ? "Share this meeting with server members, or make it public with an unguessable link. Audio is not shared."
    : "Sharing makes this meeting visible to members of this server with channel access. Audio is not shared.";

  return (
    <Modal opened={opened} onClose={onClose} title="Share meeting" centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {intro}
        </Text>

        {!sharingEnabled ? (
          <Text size="sm" c="dimmed">
            Sharing is disabled for this server.
          </Text>
        ) : null}

        {sharingEnabled && isShared ? (
          <>
            <TextInput
              label={visibility === "public" ? "Public link" : "Shared link"}
              description={meetingTitle}
              value={shareUrl}
              readOnly
              rightSection={
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={onCopyLink}
                  aria-label="Copy share link"
                >
                  <IconLink size={16} />
                </ActionIcon>
              }
            />

            {publicSharingEnabled ? (
              <Checkbox
                checked={acknowledgePublic}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setAcknowledgePublic(event.currentTarget.checked)
                }
                label="I understand anyone with this public link can view the full meeting."
              />
            ) : null}

            <Group justify="space-between" align="center" wrap="wrap">
              <Button
                variant="light"
                color="red"
                onClick={() => onSetVisibility("private")}
                loading={sharePending}
              >
                Turn off sharing
              </Button>
              <Group gap="xs">
                <Button
                  variant="subtle"
                  leftSection={<IconRefresh size={14} />}
                  onClick={onRotate}
                  loading={rotatePending}
                >
                  Rotate link
                </Button>
                {toggle ? (
                  <Button
                    variant="subtle"
                    onClick={() =>
                      onSetVisibility(toggle.next, {
                        acknowledgePublic:
                          toggle.next === "public"
                            ? acknowledgePublic
                            : undefined,
                      })
                    }
                    loading={sharePending}
                    disabled={toggle.next === "public" && !canMakePublic}
                  >
                    {toggle.label}
                  </Button>
                ) : null}
                <Button
                  variant="subtle"
                  leftSection={<IconLink size={14} />}
                  onClick={onCopyLink}
                >
                  Copy link
                </Button>
              </Group>
            </Group>
          </>
        ) : null}

        {sharingEnabled && !isShared ? (
          <>
            {publicSharingEnabled ? (
              <Checkbox
                checked={acknowledgePublic}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setAcknowledgePublic(event.currentTarget.checked)
                }
                label="I understand anyone with this public link can view the full meeting."
              />
            ) : null}
            <Group gap="xs">
              <Button
                onClick={() => onSetVisibility("server")}
                loading={sharePending}
              >
                Share with server
              </Button>
              {publicSharingEnabled ? (
                <Button
                  variant="light"
                  onClick={() =>
                    onSetVisibility("public", { acknowledgePublic: true })
                  }
                  loading={sharePending}
                  disabled={!canMakePublic}
                >
                  Share publicly
                </Button>
              ) : null}
            </Group>
          </>
        ) : null}

        {shareError ? (
          <Text size="xs" c="red">
            {shareError}
          </Text>
        ) : null}
      </Stack>
    </Modal>
  );
}

export type { MeetingShareModalProps };
