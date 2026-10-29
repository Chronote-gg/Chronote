import { useOptionalMeetingBrowseContext } from "../contexts/MeetingBrowseContext";
import {
  Box,
  Divider,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  useMantineTheme,
} from "@mantine/core";
import {
  IconCalendarEvent,
  IconCreditCard,
  IconMessageCircle,
  IconSettings,
  IconUserCog,
  IconSparkles,
  IconUpload,
} from "@tabler/icons-react";
import type { ComponentType, ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";
import { type Guild, useGuildContext } from "../contexts/GuildContext";
import MeetingSources, { type MeetingSource } from "./MeetingSources";
import type { MeetingBrowseScope } from "../../types/meetingBrowse";
import {
  meetingBrowseSearchSchema,
  selectMeetingSource,
} from "../utils/meetingBrowseSearch";
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
  scope?: MeetingBrowseScope;
  sources?: MeetingSource[];
  onSelect?: (scope: MeetingBrowseScope) => void;
};

type NavItem = {
  label: string;
  value:
    | "meetings"
    | "upload"
    | "personal-settings"
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
    label: "Meetings",
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
  scope,
  sources = guilds,
  onSelect,
}: SiteNavbarViewProps) {
  const theme = useMantineTheme();
  const serverIdFromPath = pathname.match(/\/portal\/server\/([^/]+)/)?.[1];
  const activeScope: MeetingBrowseScope =
    scope ??
    (serverIdFromPath
      ? { kind: "guild", serverId: serverIdFromPath }
      : { kind: "all" });
  const activeServerId =
    activeScope.kind === "guild" ? activeScope.serverId : null;
  const resolvedGuild = guilds.find((guild) => guild.id === activeServerId);
  const canManage = resolvedGuild?.canManage ?? false;
  const canAsk = Boolean(resolvedGuild);
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
      (!item.to && !canAsk) ||
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
        <NavSection label="Workspace">
          <Stack gap={4}>{PERSONAL_NAV_ITEMS.map(renderNavItem)}</Stack>
        </NavSection>

        <Divider />

        <Box visibleFrom={pathname === "/portal/meetings" ? "sm" : undefined}>
          <NavSection label="Sources">
            <MeetingSources
              sources={sources}
              scope={activeScope}
              onSelect={(next) => {
                onSelect?.(next);
                onClose?.();
              }}
            />
          </NavSection>
        </Box>
        <NavSection label="Server">
          <Stack gap={4}>{SERVER_NAV_ITEMS.map(renderNavItem)}</Stack>
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
  const { selectedGuildId, setSelectedGuildId, guilds } = useGuildContext();
  const browse = useOptionalMeetingBrowseContext();
  const rawSearch = useSearch({ strict: false });
  const search = meetingBrowseSearchSchema.parse(rawSearch);
  const scope: MeetingBrowseScope =
    pathname === "/portal/meetings"
      ? search.scope === "guild" && search.serverId
        ? { kind: "guild", serverId: search.serverId }
        : search.scope === "personal"
          ? { kind: "personal" }
          : { kind: "all" }
      : pathname.match(/\/portal\/server\/([^/]+)/)?.[1]
        ? { kind: "guild", serverId: pathname.split("/")[3] }
        : { kind: "all" };
  const navigate = useNavigate();

  return (
    <SiteNavbarView
      authState={authState}
      guilds={guilds}
      onClose={onClose}
      onNavigate={(to) => navigate({ to })}
      pathname={pathname}
      selectedGuildId={selectedGuildId}
      scope={scope}
      sources={browse?.sources}
      onSelect={(next) => {
        setSelectedGuildId(
          next.kind === "guild" &&
            guilds.some((guild) => guild.id === next.serverId)
            ? next.serverId
            : null,
        );
        navigate({
          to: "/portal/meetings",
          search: selectMeetingSource(search, next),
        });
      }}
    />
  );
}

export default SiteNavbar;
