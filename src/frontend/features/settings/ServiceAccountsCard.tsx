import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconPlus,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import { uiOverlays } from "../../uiTokens";
import {
  MCP_SERVICE_ACCOUNT_MAX_EXPIRY_DAYS,
  MCP_SERVICE_ACCOUNT_NAME_MAX_LENGTH,
  type McpServiceAccountScope,
} from "../../../types/mcpServiceAccount";
import type { ChannelOption } from "../../utils/settingsChannels";

export type ServiceAccountSummary = {
  tokenId: string;
  botUserId: string;
  name: string;
  scopes: McpServiceAccountScope[];
  channelIds?: string[];
  createdAt: string;
  expiresAt?: number;
};

export type CreateServiceAccountInput = {
  botUserId: string;
  name: string;
  scopes: McpServiceAccountScope[];
  channelIds?: string[];
  expiresInDays?: number;
};

type ServiceAccountsCardProps = {
  accounts: ServiceAccountSummary[];
  loading: boolean;
  busy: boolean;
  /** False when the viewer has Manage Server but not Administrator. */
  canCreate: boolean;
  voiceChannels: ChannelOption[];
  /** Returns the raw token, which is shown once and never retrievable again. */
  onCreate: (input: CreateServiceAccountInput) => Promise<string | undefined>;
  onRevoke: (tokenId: string) => Promise<void>;
};

const SCOPE_OPTIONS: Array<{ value: McpServiceAccountScope; label: string }> = [
  { value: "meetings:read", label: "Read meetings and notes" },
  { value: "transcripts:read", label: "Read transcripts" },
];

const DISCORD_ID_PATTERN = /^\d{17,20}$/;

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const formatExpiry = (expiresAt?: number) => {
  if (!expiresAt) return "No expiry";
  return `Expires ${formatDate(new Date(expiresAt * 1000).toISOString())}`;
};

const scopeLabel = (scope: McpServiceAccountScope) =>
  SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope;

type TokenRevealProps = { token: string; onDone: () => void };

const TokenReveal = ({ token, onDone }: TokenRevealProps) => (
  <Stack gap="md">
    <Alert
      color="yellow"
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title="Copy this token now"
    >
      Chronote stores only a hash of it. Once you close this dialog it cannot be
      shown again, and a lost token has to be revoked and replaced.
    </Alert>
    <Code block data-testid="service-account-token">
      {token}
    </Code>
    <Group justify="flex-end">
      <CopyButton value={token}>
        {({ copied, copy }) => (
          <Button
            variant="light"
            leftSection={
              copied ? <IconCheck size={16} /> : <IconCopy size={16} />
            }
            onClick={copy}
          >
            {copied ? "Copied" : "Copy token"}
          </Button>
        )}
      </CopyButton>
      <Button onClick={onDone}>Done</Button>
    </Group>
  </Stack>
);

type ServiceAccountRowProps = {
  account: ServiceAccountSummary;
  channelLabels: Map<string, string>;
  busy: boolean;
  onRevoke: (tokenId: string) => Promise<void>;
};

const ServiceAccountRow = ({
  account,
  channelLabels,
  busy,
  onRevoke,
}: ServiceAccountRowProps) => (
  <Surface tone="soft" p="md" data-testid="service-account-row">
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Stack gap={6}>
        <Group gap="xs">
          <Text fw={600}>{account.name}</Text>
          {account.scopes.map((scope) => (
            <Badge key={scope} size="sm" variant="light">
              {scopeLabel(scope)}
            </Badge>
          ))}
        </Group>
        <Text size="sm" c="dimmed">
          Acts as bot {account.botUserId}
        </Text>
        <Text size="sm" c="dimmed">
          {account.channelIds?.length
            ? `Limited to ${account.channelIds
                .map((id) => channelLabels.get(id) ?? id)
                .join(", ")}`
            : "All channels the bot can reach"}
        </Text>
        <Text size="xs" c="dimmed">
          Created {formatDate(account.createdAt)} ·{" "}
          {formatExpiry(account.expiresAt)}
        </Text>
      </Stack>
      <Tooltip label="Revoke">
        <ActionIcon
          variant="subtle"
          color="red"
          disabled={busy}
          aria-label={`Revoke ${account.name}`}
          onClick={() => {
            void onRevoke(account.tokenId);
          }}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  </Surface>
);

export function ServiceAccountsCard({
  accounts,
  loading,
  busy,
  canCreate,
  voiceChannels,
  onCreate,
  onRevoke,
}: ServiceAccountsCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [botUserId, setBotUserId] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<McpServiceAccountScope[]>([
    "meetings:read",
  ]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(90);
  const [token, setToken] = useState<string | undefined>();

  const channelLabels = new Map(
    voiceChannels.map((channel) => [channel.value, channel.label]),
  );
  const botUserIdValid = DISCORD_ID_PATTERN.test(botUserId.trim());
  const submitDisabled =
    busy || !botUserIdValid || !name.trim() || scopes.length === 0;

  const resetForm = () => {
    setBotUserId("");
    setName("");
    setScopes(["meetings:read"]);
    setChannelIds([]);
    setExpiresInDays(90);
  };

  const closeModal = () => {
    setModalOpen(false);
    setToken(undefined);
    resetForm();
  };

  const handleCreate = async () => {
    const created = await onCreate({
      botUserId: botUserId.trim(),
      name: name.trim(),
      scopes,
      channelIds: channelIds.length > 0 ? channelIds : undefined,
      expiresInDays,
    });
    if (created) setToken(created);
  };

  return (
    <Surface p="lg" data-testid="service-accounts-card">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4}>
            <Group gap="xs">
              <IconRobot size={18} />
              <Text fw={600}>Service accounts</Text>
            </Group>
            <Text size="sm" c="dimmed">
              Long-lived read-only tokens that let an unattended agent reach
              Chronote as a Discord bot already in this server.
            </Text>
          </Stack>
          <Tooltip
            label="Only a server Administrator can create a service account"
            disabled={canCreate}
          >
            <Button
              leftSection={<IconPlus size={16} />}
              disabled={!canCreate || busy}
              onClick={() => setModalOpen(true)}
            >
              New service account
            </Button>
          </Tooltip>
        </Group>

        <Text size="sm" c="dimmed">
          A token reads exactly what its bot can read. Give the bot a Discord
          role that reaches the right channels, and remove that role to revoke
          the agent.
        </Text>

        {!loading && accounts.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="service-accounts-empty">
            No service accounts yet.
          </Text>
        ) : (
          <Stack gap="sm">
            {accounts.map((account) => (
              <ServiceAccountRow
                key={account.tokenId}
                account={account}
                channelLabels={channelLabels}
                busy={busy}
                onRevoke={onRevoke}
              />
            ))}
          </Stack>
        )}
      </Stack>

      <Modal
        opened={modalOpen}
        onClose={closeModal}
        title={token ? "Service account created" : "New service account"}
        centered
        overlayProps={uiOverlays.modal}
      >
        {token ? (
          <TokenReveal token={token} onDone={closeModal} />
        ) : (
          <Stack gap="md">
            <TextInput
              label="Bot user ID"
              description="The Discord application the agent runs as. It must already be in this server, and must not have Administrator."
              placeholder="1234567890123456789"
              value={botUserId}
              error={
                botUserId.length > 0 && !botUserIdValid
                  ? "Expected a Discord user ID"
                  : undefined
              }
              onChange={(event) => setBotUserId(event.currentTarget.value)}
            />
            <TextInput
              label="Name"
              description="How you will recognize this token later."
              placeholder="Ops agent"
              maxLength={MCP_SERVICE_ACCOUNT_NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <MultiSelect
              label="Scopes"
              data={SCOPE_OPTIONS}
              value={scopes}
              onChange={(value) =>
                setScopes(value as unknown as McpServiceAccountScope[])
              }
            />
            <MultiSelect
              label="Limit to channels"
              description="Optional. Leave empty to allow every channel the bot can already reach."
              data={voiceChannels}
              searchable
              value={channelIds}
              onChange={setChannelIds}
            />
            <NumberInput
              label="Expires in days"
              description="Optional. Leave empty for no expiry."
              min={1}
              max={MCP_SERVICE_ACCOUNT_MAX_EXPIRY_DAYS}
              value={expiresInDays}
              onChange={(value) =>
                setExpiresInDays(
                  typeof value === "number" && Number.isFinite(value)
                    ? value
                    : undefined,
                )
              }
            />
            <Group justify="flex-end">
              <Button variant="subtle" onClick={closeModal}>
                Cancel
              </Button>
              <Button
                loading={busy}
                disabled={submitDisabled}
                onClick={() => {
                  void handleCreate();
                }}
              >
                Create
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Surface>
  );
}
