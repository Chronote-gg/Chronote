import { useEffect, useState } from "react";
import { Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";

export type PersonalMeetingShareGrant =
  | { targetType: "user"; userId: string }
  | { targetType: "guild"; guildId: string };

export type PersonalMeetingShareModalProps = {
  opened: boolean;
  onClose: () => void;
  meetingTitle: string;
  accessGrants: PersonalMeetingShareGrant[];
  saving: boolean;
  error: string | null;
  onSave: (input: { userIds: string[]; guildIds: string[] }) => void;
};

const splitIds = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );

const joinGrantIds = (
  grants: PersonalMeetingShareGrant[],
  targetType: "user" | "guild",
) =>
  grants
    .filter((grant) => grant.targetType === targetType)
    .map((grant) =>
      grant.targetType === "user" ? grant.userId : grant.guildId,
    )
    .join("\n");

export function PersonalMeetingShareModal({
  opened,
  onClose,
  meetingTitle,
  accessGrants,
  saving,
  error,
  onSave,
}: PersonalMeetingShareModalProps) {
  const [userIdsText, setUserIdsText] = useState("");
  const [guildIdsText, setGuildIdsText] = useState("");

  useEffect(() => {
    if (!opened) return;
    setUserIdsText(joinGrantIds(accessGrants, "user"));
    setGuildIdsText(joinGrantIds(accessGrants, "guild"));
  }, [accessGrants, opened]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Share personal meeting"
      centered
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Share {meetingTitle} with explicit Discord users or every member of a
          Discord server. Use numeric Discord IDs, one per line or separated by
          commas.
        </Text>
        <Textarea
          label="User IDs"
          description="People listed here can view this personal meeting from My Meetings."
          placeholder="123456789012345678"
          minRows={3}
          value={userIdsText}
          onChange={(event) => setUserIdsText(event.currentTarget.value)}
          data-testid="personal-share-user-ids"
        />
        <Textarea
          label="Server IDs"
          description="Members of these servers can access the meeting while they remain in the server."
          placeholder="123456789012345678"
          minRows={3}
          value={guildIdsText}
          onChange={(event) => setGuildIdsText(event.currentTarget.value)}
          data-testid="personal-share-guild-ids"
        />
        {error ? (
          <Text size="xs" c="red" data-testid="personal-share-error">
            {error}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            loading={saving}
            onClick={() =>
              onSave({
                userIds: splitIds(userIdsText),
                guildIds: splitIds(guildIdsText),
              })
            }
            data-testid="personal-share-save"
          >
            Save sharing
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default PersonalMeetingShareModal;
