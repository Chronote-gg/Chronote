import {
  Button,
  Divider,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  IconBook2,
  IconCalendarEvent,
  IconChevronRight,
  IconCreditCard,
  IconMessageCircle,
  IconSettings,
  IconUserCog,
  IconServer,
  IconSparkles,
  IconUpload,
} from "@tabler/icons-react";
import type { ComponentType, ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";
import { type Guild, useGuildContext } from "../contexts/GuildContext";
import { uiRadii } from "../uiTokens";

type SiteNavbarProps = {
  onClose?: () => void;
  pathname: string;
};

type SiteNavbarViewProps = SiteNavbarProps & {
  authState: ReturnType<typeof useAuth>["state"];
  guilds: Guild[];
  selectedGuildId: string | null;
  onNavigate: (to: string) => void;
};

type NavItem = {
  label: string;
  value:
    | "meetings"
    | "upload"
    | "personal-settings"
    | "library"
    | "ask"
    | "billing"
    | "settings";
  icon: ComponentType<{ size?: number }>;
  requiresAuth: boolean;
  requiresManage?: boolean;
  to?: string;
};

const PERSONAL_NAV_ITEMS: NavItem[] = [
  {
    label: "My Meetings",
    value: "meetings",
    icon: IconCalendarEvent,
    requiresAuth: true,
    to: "/portal/meetings",
  },
  {
    label: "Upload Media",
    value: "upload",
    icon: IconUpload,
    requiresAuth: true,
    to: "/portal/upload",
  },
  {
    label: "Personal Settings",
    value: "personal-settings",
    icon: IconUserCog,
    requiresAuth: true,
    to: "/portal/settings",
  },
];

const SERVER_NAV_ITEMS: NavItem[] = [
  {
    label: "Library",
    value: "library",
    icon: IconBook2,
    requiresAuth: true,
  },
  { label: "Ask", value: "ask", icon: IconSparkles, requiresAuth: true },
  {
    label: "Billing",
    value: "billing",
    icon: IconCreditCard,
    requiresAuth: true,
    requiresManage: true,
  },
  {
    label: "Server Settings",
    value: "settings",
    icon: IconSettings,
    requiresAuth: true,
    requiresManage: true,
  },
];

const SUPPORT_EMAIL = "basic@basicbit.net";
const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
  "Chronote support",
)}`;

const NavSection = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <Stack gap={6}>
    <Text size="xs" fw={700} c="dimmed">
      {label}
    </Text>
    {children}
  </Stack>
);

export function SiteNavbarView({
  authState,
  guilds,
  onClose,
  onNavigate,
  pathname,
  selectedGuildId,
}: SiteNavbarViewProps) {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";

  const serverIdFromPath = pathname.match(/\/portal\/server\/([^/]+)/)?.[1];
  const selectedGuild = selectedGuildId
    ? (guilds.find((g) => g.id === selectedGuildId) ?? null)
    : null;
  const pathGuild = serverIdFromPath
    ? (guilds.find((g) => g.id === serverIdFromPath) ?? null)
    : null;
  const resolvedGuild = selectedGuild ?? pathGuild;
  const activeServerId = resolvedGuild?.id ?? selectedGuildId ?? null;
  const selectedServerName = resolvedGuild?.name ?? null;
  const canManage = resolvedGuild?.canManage ?? false;
  const isAuthenticated = authState === "authenticated";
  const navRadius = theme.radius[uiRadii.control];

  const resolveServerPath = (page: string) =>
    activeServerId
      ? `/portal/server/${activeServerId}/${page}`
      : "/portal/select-server";
  const isServerNavActive = (page: string) =>
    new RegExp(`^/portal/server/[^/]+/${page}(?:/|$)`).test(pathname);
  const resolveItemDescription = (item: NavItem) => {
    if (item.to) return undefined;
    if (!activeServerId) return "Choose a server first";
    if (item.requiresManage && !canManage) return "Requires Manage Server";
    return undefined;
  };
  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = item.to
      ? pathname === item.to || pathname.startsWith(`${item.to}/`)
      : isServerNavActive(item.value);
    const disabled =
      (item.requiresAuth && !isAuthenticated) ||
      (!item.to && !activeServerId) ||
      (item.requiresManage && !canManage);
    return (
      <NavLink
        key={item.value}
        label={item.label}
        description={resolveItemDescription(item)}
        data-testid={`nav-${item.value}`}
        leftSection={
          <ThemeIcon
            variant={isActive ? "light" : "transparent"}
            color={isActive ? "brand" : "gray"}
            size={34}
          >
            <Icon size={18} />
          </ThemeIcon>
        }
        active={isActive}
        disabled={disabled}
        onClick={
          disabled
            ? undefined
            : () => {
                onNavigate(item.to ?? resolveServerPath(item.value));
                onClose?.();
              }
        }
        style={{
          borderRadius: navRadius,
        }}
      />
    );
  };

  return (
    <ScrollArea h="100%" offsetScrollbars data-visual-scroll>
      <Stack gap="lg" p="md">
        <NavSection label="Personal">
          <Stack gap={4}>{PERSONAL_NAV_ITEMS.map(renderNavItem)}</Stack>
        </NavSection>

        <Divider />

        <NavSection label="Server">
          <Stack gap={6}>
            <Button
              variant="light"
              color={activeServerId ? "brand" : "gray"}
              leftSection={<IconServer size={16} />}
              rightSection={<IconChevronRight size={16} />}
              data-testid="nav-server-button"
              data-selected-guild-id={activeServerId ?? ""}
              disabled={!isAuthenticated}
              justify="space-between"
              styles={{
                section: { marginInlineStart: 8, marginInlineEnd: 0 },
              }}
              onClick={
                isAuthenticated
                  ? () => {
                      onNavigate("/portal/select-server");
                      onClose?.();
                    }
                  : undefined
              }
            >
              <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                <Text
                  fw={600}
                  size="sm"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: isDark ? theme.white : theme.colors.dark[9],
                  }}
                >
                  {selectedServerName || "Choose a server"}
                </Text>
              </Group>
            </Button>
            <Stack gap={4}>{SERVER_NAV_ITEMS.map(renderNavItem)}</Stack>
          </Stack>
        </NavSection>

        <Divider />

        <NavSection label="Help">
          <NavLink
            label="Support"
            description="Email support"
            data-testid="nav-support"
            leftSection={
              <ThemeIcon variant="transparent" color="gray" size={34}>
                <IconMessageCircle size={18} />
              </ThemeIcon>
            }
            onClick={() => window.open(SUPPORT_MAILTO, "_blank")}
            style={{ borderRadius: theme.radius[uiRadii.control] }}
          />
        </NavSection>
      </Stack>
    </ScrollArea>
  );
}

export function SiteNavbar({ onClose, pathname }: SiteNavbarProps) {
  const { state: authState } = useAuth();
  const { selectedGuildId, guilds } = useGuildContext();
  const navigate = useNavigate();

  return (
    <SiteNavbarView
      authState={authState}
      guilds={guilds}
      onClose={onClose}
      onNavigate={(to) => navigate({ to })}
      pathname={pathname}
      selectedGuildId={selectedGuildId}
    />
  );
}

export default SiteNavbar;
