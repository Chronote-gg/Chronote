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
  IconChevronRight,
  IconCreditCard,
  IconMessageCircle,
  IconSettings,
  IconServer,
  IconSparkles,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";
import { uiRadii } from "../uiTokens";

type SiteNavbarProps = {
  onClose?: () => void;
  pathname: string;
};

const NAV_ITEMS: Array<{
  label: string;
  value: "library" | "ask" | "billing" | "settings";
  icon: ComponentType<{ size?: number }>;
  requiresAuth: boolean;
  requiresManage?: boolean;
}> = [
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
    label: "Settings",
    value: "settings",
    icon: IconSettings,
    requiresAuth: true,
    requiresManage: true,
  },
];

export function SiteNavbar({ onClose, pathname }: SiteNavbarProps) {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const { state: authState } = useAuth();
  const { selectedGuildId, guilds } = useGuildContext();
  const navigate = useNavigate();

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

  const resolveServerPath = (page: string) =>
    activeServerId
      ? `/portal/server/${activeServerId}/${page}`
      : "/portal/select-server";

  return (
    <ScrollArea h="100%" offsetScrollbars data-visual-scroll>
      <Stack gap="md" p="md">
        {authState === "authenticated" ? (
          <Stack gap={6}>
            <Button
              variant="light"
              color="gray"
              leftSection={<IconServer size={16} />}
              rightSection={<IconChevronRight size={16} />}
              data-testid="nav-server-button"
              data-selected-guild-id={selectedGuildId ?? ""}
              justify="space-between"
              styles={{
                section: { marginInlineStart: 8, marginInlineEnd: 0 },
              }}
              onClick={() => {
                navigate({ to: "/portal/select-server" });
                onClose?.();
              }}
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
          </Stack>
        ) : null}

        <Divider />

        <Stack gap={4}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname.includes(`/${item.value}`);
            const disabled =
              (item.requiresAuth && authState !== "authenticated") ||
              (item.requiresManage && !canManage);
            const navRadius = theme.radius[uiRadii.control];
            return (
              <NavLink
                key={item.value}
                label={item.label}
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
                onClick={() => {
                  navigate({ to: resolveServerPath(item.value) });
                  onClose?.();
                }}
                style={{
                  borderRadius: navRadius,
                }}
              />
            );
          })}
        </Stack>

        <Divider />

        <Stack gap={4}>
          <NavLink
            label="Support"
            description="Docs and quick help"
            data-testid="nav-support"
            leftSection={
              <ThemeIcon variant="transparent" color="gray" size={34}>
                <IconMessageCircle size={18} />
              </ThemeIcon>
            }
            onClick={() => window.open("https://chronote.gg", "_blank")}
            style={{ borderRadius: theme.radius[uiRadii.control] }}
          />
        </Stack>
      </Stack>
    </ScrollArea>
  );
}

export default SiteNavbar;
