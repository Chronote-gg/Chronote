import { useEffect, useState, type ChangeEvent } from "react";
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

type PublicAcknowledgeCheckboxProps = {
  acknowledgePublic: boolean;
  onAcknowledgePublicChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

function PublicAcknowledgeCheckbox({
  acknowledgePublic,
  onAcknowledgePublicChange,
}: PublicAcknowledgeCheckboxProps) {
  return (
    <Checkbox
      checked={acknowledgePublic}
      onChange={onAcknowledgePublicChange}
      label="I understand anyone with this public link can view the full meeting."
    />
  );
}

type SharedControlsProps = {
  visibility: MeetingShareVisibility;
  meetingTitle: string;
  shareUrl: string;
  publicSharingEnabled: boolean;
  acknowledgePublic: boolean;
  canMakePublic: boolean;
  sharePending: boolean;
  rotatePending: boolean;
  onCopyLink: () => void;
  onSetVisibility: (
    visibility: MeetingShareVisibility,
    options?: { acknowledgePublic?: boolean },
  ) => void;
  onRotate: () => void;
  onAcknowledgePublicChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

function SharedControls({
  visibility,
  meetingTitle,
  shareUrl,
  publicSharingEnabled,
  acknowledgePublic,
  canMakePublic,
  sharePending,
  rotatePending,
  onCopyLink,
  onSetVisibility,
  onRotate,
  onAcknowledgePublicChange,
}: SharedControlsProps) {
  const toggle = publicSharingEnabled ? resolveToggleLabel(visibility) : null;

  return (
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
        <PublicAcknowledgeCheckbox
          acknowledgePublic={acknowledgePublic}
          onAcknowledgePublicChange={onAcknowledgePublicChange}
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
                    toggle.next === "public" ? acknowledgePublic : undefined,
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
  );
}

type UnsharedControlsProps = {
  publicSharingEnabled: boolean;
  acknowledgePublic: boolean;
  canMakePublic: boolean;
  sharePending: boolean;
  onSetVisibility: (
    visibility: MeetingShareVisibility,
    options?: { acknowledgePublic?: boolean },
  ) => void;
  onAcknowledgePublicChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

function UnsharedControls({
  publicSharingEnabled,
  acknowledgePublic,
  canMakePublic,
  sharePending,
  onSetVisibility,
  onAcknowledgePublicChange,
}: UnsharedControlsProps) {
  return (
    <>
      {publicSharingEnabled ? (
        <PublicAcknowledgeCheckbox
          acknowledgePublic={acknowledgePublic}
          onAcknowledgePublicChange={onAcknowledgePublicChange}
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
  );
}

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
  const canMakePublic = publicSharingEnabled && acknowledgePublic;
  const onAcknowledgePublicChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAcknowledgePublic(event.currentTarget.checked);
  };

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
          <SharedControls
            visibility={visibility}
            meetingTitle={meetingTitle}
            shareUrl={shareUrl}
            publicSharingEnabled={publicSharingEnabled}
            acknowledgePublic={acknowledgePublic}
            canMakePublic={canMakePublic}
            sharePending={sharePending}
            rotatePending={rotatePending}
            onCopyLink={onCopyLink}
            onSetVisibility={onSetVisibility}
            onRotate={onRotate}
            onAcknowledgePublicChange={onAcknowledgePublicChange}
          />
        ) : null}

        {sharingEnabled && !isShared ? (
          <UnsharedControls
            publicSharingEnabled={publicSharingEnabled}
            acknowledgePublic={acknowledgePublic}
            canMakePublic={canMakePublic}
            sharePending={sharePending}
            onSetVisibility={onSetVisibility}
            onAcknowledgePublicChange={onAcknowledgePublicChange}
          />
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
