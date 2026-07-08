import { Box } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react";
import { SiteNavbarView } from "./SiteNavbar";
import type { Guild } from "../contexts/GuildContext";

const guilds: Guild[] = [
  { id: "guild-design", name: "Design Review Server", canManage: true },
  { id: "guild-community", name: "Community Server", canManage: false },
];

const meta: Meta<typeof SiteNavbarView> = {
  title: "Components/SiteNavbar",
  component: SiteNavbarView,
  parameters: {
    layout: "fullscreen",
  },
  render: (args) => (
    <Box w={320} h={720} bg="dark.8">
      <SiteNavbarView {...args} />
    </Box>
  ),
  args: {
    authState: "authenticated",
    guilds,
    selectedGuildId: "guild-design",
    onNavigate: () => {},
  },
};

export default meta;

type Story = StoryObj<typeof SiteNavbarView>;

export const PersonalWorkspace: Story = {
  args: {
    pathname: "/portal/settings",
  },
};

export const ServerWorkspace: Story = {
  args: {
    pathname: "/portal/server/guild-design/library",
  },
};

export const ServerWorkspaceMember: Story = {
  args: {
    pathname: "/portal/server/guild-community/ask",
    selectedGuildId: "guild-community",
  },
};

export const NoServerSelected: Story = {
  args: {
    pathname: "/portal/meetings",
    selectedGuildId: null,
  },
};
