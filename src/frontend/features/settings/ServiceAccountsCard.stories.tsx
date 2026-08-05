import type { Meta, StoryObj } from "@storybook/react";
import { ServiceAccountsCard } from "./ServiceAccountsCard";

const meta: Meta<typeof ServiceAccountsCard> = {
  title: "Settings/ServiceAccountsCard",
  component: ServiceAccountsCard,
  args: {
    loading: false,
    busy: false,
    canCreate: true,
    accounts: [],
    voiceChannels: [
      {
        value: "voice-1",
        label: "Weekly sync",
        botAccess: true,
        missingPermissions: [],
      },
      {
        value: "voice-2",
        label: "Leadership",
        botAccess: true,
        missingPermissions: [],
      },
    ],
    onCreate: async () => "cnsa_example_token_value_shown_once",
    onRevoke: async () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof ServiceAccountsCard>;

export const Empty: Story = {};

export const WithAccounts: Story = {
  args: {
    accounts: [
      {
        tokenId: "11111111-1111-1111-1111-111111111111",
        botUserId: "100000000000000001",
        name: "Ops agent",
        scopes: ["meetings:read"],
        channelIds: ["voice-1"],
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: 1_800_000_000,
      },
      {
        tokenId: "22222222-2222-2222-2222-222222222222",
        botUserId: "100000000000000002",
        name: "Notes archiver",
        scopes: ["meetings:read", "transcripts:read"],
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    ],
  },
};

/** A Manage Server member who is not an Administrator can look but not mint. */
export const CannotCreate: Story = {
  args: {
    canCreate: false,
    accounts: [
      {
        tokenId: "11111111-1111-1111-1111-111111111111",
        botUserId: "100000000000000001",
        name: "Ops agent",
        scopes: ["meetings:read"],
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  },
};
