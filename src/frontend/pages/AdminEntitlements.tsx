import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  LoadingOverlay,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useAuth } from "../contexts/AuthContext";
import Surface from "../components/Surface";
import { trpc } from "../services/trpc";
import { uiOverlays } from "../uiTokens";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../trpc/router";

type RouterOutput = inferRouterOutputs<AppRouter>;
type Grant = RouterOutput["adminEntitlements"]["list"]["items"][number];
type TierValue = "basic" | "pro";
type ExpiryMode = "none" | "expires";
type StatusFilter = "all" | "active" | "revoked" | "expired";
type TierFilter = "all" | TierValue;

const tierLabel = (tier: TierValue) => (tier === "pro" ? "Pro" : "Basic");
const normalValueLabel = (tier: TierValue) =>
  tier === "basic" ? "$5/month" : "the normal Pro plan price";

const statusColor = (status: string) => {
  if (status === "active") return "teal";
  if (status === "expired") return "yellow";
  return "gray";
};

const formatDateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "No expiry";

const buildExpiryIso = (mode: ExpiryMode, dateValue: string) => {
  if (mode !== "expires" || !dateValue) return undefined;
  return new Date(`${dateValue}T23:59:59.999Z`).toISOString();
};

const buildProspectMessage = (grant: Grant, guildName?: string) => {
  const plan = tierLabel(grant.tier);
  const guildLabel = guildName || grant.label || `server ${grant.guildId}`;
  const expiry = grant.expiresAt
    ? ` This comp runs through ${new Date(
        grant.expiresAt,
      ).toLocaleDateString()}.`
    : "";
  return `I set ${guildLabel} up with Chronote ${plan} for free. This is normally ${normalValueLabel(
    grant.tier,
  )}. No payment is required.${expiry} If you want to support us later, you can start paying from the billing page or upgrade when you're ready.`;
};

function AdminEntitlementsAccessDenied() {
  return (
    <Surface tone="soft" p="xl">
      <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
        Super admin access is required to view this page.
      </Alert>
    </Surface>
  );
}

export default function AdminEntitlements() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);
  const trpcUtils = trpc.useUtils();
  const [guildId, setGuildId] = useState("");
  const [tier, setTier] = useState<TierValue>("basic");
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>("none");
  const [expiresOn, setExpiresOn] = useState("");
  const [label, setLabel] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientContact, setRecipientContact] = useState("");
  const [reason, setReason] = useState("");
  const [publicNote, setPublicNote] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [filterGuildId, setFilterGuildId] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");

  const query = trpc.adminEntitlements.list.useQuery(
    {
      guildId: filterGuildId.trim() || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      tier: tierFilter === "all" ? undefined : tierFilter,
      limit: 100,
    },
    { enabled: isSuperAdmin },
  );

  const createGrant = trpc.adminEntitlements.create.useMutation({
    onSuccess: ({ grant }) => {
      notifications.show({
        color: "teal",
        title: "Grant created",
        message: "The comped plan is now active for that guild ID.",
      });
      setGuildId("");
      setLabel("");
      setRecipientName("");
      setRecipientContact("");
      setReason("");
      setPublicNote("");
      setInternalNotes("");
      setExpiryMode("none");
      setExpiresOn("");
      void trpcUtils.adminEntitlements.list.invalidate();
      void trpcUtils.billing.me.invalidate({ serverId: grant.guildId });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Grant failed",
        message: error.message,
      });
    },
  });

  const revokeGrant = trpc.adminEntitlements.revoke.useMutation({
    onSuccess: (_result, variables) => {
      notifications.show({
        color: "teal",
        title: "Grant revoked",
        message: "The comped plan no longer contributes to this guild.",
      });
      const revoked = grants.find(
        (grant) => grant.grantId === variables.grantId,
      );
      void trpcUtils.adminEntitlements.list.invalidate();
      if (revoked) {
        void trpcUtils.billing.me.invalidate({ serverId: revoked.guildId });
      }
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Revoke failed",
        message: error.message,
      });
    },
  });

  const grants = query.data?.items ?? [];
  const guildsById = query.data?.guildsById ?? {};
  const installedGuildIds = useMemo(
    () => new Set(query.data?.installedGuildIds ?? []),
    [query.data?.installedGuildIds],
  );

  const handleSubmit = () => {
    createGrant.mutate({
      guildId: guildId.trim(),
      tier,
      expiresAt: buildExpiryIso(expiryMode, expiresOn),
      label,
      recipientName,
      recipientContact,
      reason,
      publicNote,
      internalNotes,
    });
  };

  const copyProspectMessage = async (grant: Grant) => {
    const message = buildProspectMessage(grant, guildsById[grant.guildId]);
    try {
      await navigator.clipboard.writeText(message);
      notifications.show({
        color: "teal",
        title: "Copied",
        message: "Prospect message copied to clipboard.",
      });
    } catch {
      notifications.show({
        color: "red",
        title: "Copy failed",
        message,
      });
    }
  };

  const confirmAndRevokeGrant = (grant: Grant) => {
    const guildLabel =
      guildsById[grant.guildId] || grant.label || grant.guildId;
    const reason = window.prompt(
      `Revoke ${tierLabel(grant.tier)} for ${guildLabel}? Enter a revocation reason to continue.`,
      "manual_revoke",
    );
    if (reason === null) return;
    revokeGrant.mutate({
      grantId: grant.grantId,
      revocationReason: reason.trim() || "manual_revoke",
    });
  };

  if (!isSuperAdmin) {
    return <AdminEntitlementsAccessDenied />;
  }

  return (
    <Stack gap="lg" data-testid="admin-entitlements-page">
      <Group justify="space-between" align="center">
        <Stack gap={2}>
          <Title order={2}>Entitlement grants</Title>
          <Text size="sm" c="dimmed">
            Comp Chronote Basic or Pro for a Discord guild ID without Stripe
            checkout.
          </Text>
        </Stack>
        <Button
          variant="default"
          onClick={() => query.refetch()}
          disabled={query.isLoading}
          data-testid="admin-entitlements-refresh"
        >
          Refresh
        </Button>
      </Group>

      <Surface tone="raised" p="lg">
        <Stack gap="md">
          <Title order={4}>Grant a server</Title>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <TextInput
              label="Discord guild ID"
              placeholder="123456789012345678"
              value={guildId}
              onChange={(event) => setGuildId(event.currentTarget.value)}
              required
              data-testid="admin-entitlements-guild-id"
            />
            <Select
              label="Plan"
              value={tier}
              onChange={(value) => setTier((value as TierValue) ?? "basic")}
              data={[
                { value: "basic", label: "Basic" },
                { value: "pro", label: "Pro" },
              ]}
            />
            <Select
              label="Expiry"
              value={expiryMode}
              onChange={(value) =>
                setExpiryMode((value as ExpiryMode) ?? "none")
              }
              data={[
                { value: "none", label: "No expiry" },
                { value: "expires", label: "Short term" },
              ]}
            />
            <TextInput
              label="Expiry date"
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.currentTarget.value)}
              disabled={expiryMode === "none"}
            />
            <TextInput
              label="Label"
              placeholder="Acme West demo server"
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
            <TextInput
              label="Recipient name"
              value={recipientName}
              onChange={(event) => setRecipientName(event.currentTarget.value)}
            />
            <TextInput
              label="Recipient contact"
              value={recipientContact}
              onChange={(event) =>
                setRecipientContact(event.currentTarget.value)
              }
            />
            <TextInput
              label="Reason"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </SimpleGrid>
          <Textarea
            label="Public note"
            description="Visible to server admins on billing surfaces."
            value={publicNote}
            onChange={(event) => setPublicNote(event.currentTarget.value)}
            minRows={2}
          />
          <Textarea
            label="Internal notes"
            description="Only visible in this superadmin tool."
            value={internalNotes}
            onChange={(event) => setInternalNotes(event.currentTarget.value)}
            minRows={3}
          />
          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              Default is no expiry. Guild lookup is not required before
              granting.
            </Text>
            <Button
              variant="gradient"
              gradient={{ from: "brand", to: "violet" }}
              onClick={handleSubmit}
              loading={createGrant.isPending}
              disabled={!guildId.trim()}
              data-testid="admin-entitlements-create"
            >
              Grant {tierLabel(tier)}
            </Button>
          </Group>
        </Stack>
      </Surface>

      <Group gap="sm" align="flex-end" wrap="wrap">
        <TextInput
          label="Filter guild ID"
          value={filterGuildId}
          onChange={(event) => setFilterGuildId(event.currentTarget.value)}
        />
        <Select
          label="Status"
          value={statusFilter}
          onChange={(value) =>
            setStatusFilter((value as StatusFilter) ?? "all")
          }
          data={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "expired", label: "Expired" },
            { value: "revoked", label: "Revoked" },
          ]}
        />
        <Select
          label="Tier"
          value={tierFilter}
          onChange={(value) => setTierFilter((value as TierFilter) ?? "all")}
          data={[
            { value: "all", label: "All" },
            { value: "basic", label: "Basic" },
            { value: "pro", label: "Pro" },
          ]}
        />
      </Group>

      <Surface tone="raised" p="lg" style={{ position: "relative" }}>
        <LoadingOverlay
          visible={query.isLoading}
          overlayProps={uiOverlays.loading}
          loaderProps={{ size: "md" }}
        />
        <Stack gap="md">
          {grants.length === 0 ? (
            <Text size="sm" c="dimmed">
              No entitlement grants match these filters.
            </Text>
          ) : (
            grants.map((grant) => {
              const guildName = guildsById[grant.guildId];
              const installed = installedGuildIds.has(grant.guildId);
              return (
                <Surface key={grant.grantId} tone="soft" p="md">
                  <Stack gap="sm">
                    <Group
                      justify="space-between"
                      align="flex-start"
                      wrap="wrap"
                    >
                      <Stack gap={2}>
                        <Group gap="xs" wrap="wrap">
                          <Text fw={600}>
                            {grant.label || guildName || grant.guildId}
                          </Text>
                          <Badge color="brand" variant="light">
                            {tierLabel(grant.tier)}
                          </Badge>
                          <Badge
                            color={statusColor(grant.effectiveStatus)}
                            variant="light"
                          >
                            {grant.effectiveStatus}
                          </Badge>
                          <Badge
                            color={installed ? "teal" : "gray"}
                            variant="light"
                          >
                            {installed ? "Installed" : "Not seen installed"}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed">
                          Guild ID: {grant.guildId}
                        </Text>
                        {guildName ? (
                          <Text size="xs" c="dimmed">
                            Bot guild name: {guildName}
                          </Text>
                        ) : null}
                      </Stack>
                      <Group gap="xs" wrap="wrap">
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => copyProspectMessage(grant)}
                        >
                          Copy message
                        </Button>
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          disabled={grant.effectiveStatus !== "active"}
                          loading={revokeGrant.isPending}
                          onClick={() => confirmAndRevokeGrant(grant)}
                        >
                          Revoke
                        </Button>
                      </Group>
                    </Group>
                    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                      <Text size="xs" c="dimmed">
                        Created: {formatDateTime(grant.createdAt)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Expires: {formatDateTime(grant.expiresAt)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Recipient: {grant.recipientName || "Not set"}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Contact: {grant.recipientContact || "Not set"}
                      </Text>
                    </SimpleGrid>
                    {grant.publicNote ? (
                      <Text size="sm">Public note: {grant.publicNote}</Text>
                    ) : null}
                    {grant.internalNotes ? (
                      <Text size="xs" c="dimmed">
                        Internal notes: {grant.internalNotes}
                      </Text>
                    ) : null}
                  </Stack>
                </Surface>
              );
            })
          )}
        </Stack>
      </Surface>
    </Stack>
  );
}
