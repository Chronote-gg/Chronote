import type { Meta, StoryObj } from "@storybook/react";
import { NotionIntegrationCard } from "./NotionIntegrationCard";

const meta: Meta<typeof NotionIntegrationCard> = {
  title: "Settings/NotionIntegrationCard",
  component: NotionIntegrationCard,
  args: {
    loading: false,
    busy: false,
    destinationLoading: false,
    destinationPages: [
      {
        id: "page-1",
        title: "Meeting archive",
        url: "https://notion.so/page-1",
      },
    ],
    voiceChannels: [
      { value: "voice-1", label: "Weekly sync", botAccess: true },
      { value: "voice-2", label: "Campaign planning", botAccess: true },
    ],
    onConnect: () => undefined,
    onSearchDestinations: () => undefined,
    onSave: async () => undefined,
    onDisable: async () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof NotionIntegrationCard>;

export const Connected: Story = {
  args: {
    status: {
      configured: true,
      userConnected: true,
      workspaceName: "Product Ops",
      automation: {
        enabled: true,
        ownerConnected: true,
        workspaceName: "Product Ops",
        destinationPageId: "page-1",
        destinationTitle: "Meeting archive",
        destinationUrl: "https://notion.so/page-1",
        channelIds: ["voice-1"],
        tags: ["recap", "planning"],
      },
    },
  },
};

export const NeedsConnection: Story = {
  args: {
    status: {
      configured: true,
      userConnected: false,
    },
  },
};

export const NeedsAttention: Story = {
  args: {
    status: {
      configured: true,
      userConnected: true,
      workspaceName: "Product Ops",
      automation: {
        enabled: true,
        ownerConnected: false,
        workspaceName: "Product Ops",
        destinationPageId: "page-1",
        destinationTitle: "Meeting archive",
        channelIds: [],
        tags: [],
        lastError: "Chronote cannot access that Notion page. Reconnect Notion.",
      },
    },
  },
};
