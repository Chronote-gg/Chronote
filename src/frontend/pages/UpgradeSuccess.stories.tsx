import type { Meta, StoryObj } from "@storybook/react";
import { UpgradeSuccessHero } from "./UpgradeSuccess";

const meta: Meta<typeof UpgradeSuccessHero> = {
  title: "Pages/UpgradeSuccessHero",
  component: UpgradeSuccessHero,
  args: {
    isAuthenticated: true,
    authLoading: false,
    loginUrl: "/auth/discord",
    serverId: "1234567890",
    serverName: "Engineering HQ",
    planLabel: "Basic",
    intervalWord: "monthly",
    promoCode: "SAVE20",
    onOpenPortal: () => {},
    onOpenBilling: () => {},
    onBackToHomepage: () => {},
  },
};

export default meta;

type Story = StoryObj<typeof UpgradeSuccessHero>;

export const Default: Story = {};

export const Annual: Story = {
  args: {
    planLabel: "Pro",
    intervalWord: "annually",
    promoCode: "",
  },
};

export const ConnectDiscordState: Story = {
  args: {
    isAuthenticated: false,
    serverId: "",
    serverName: "",
    planLabel: "",
    intervalWord: "",
    promoCode: "",
  },
};
