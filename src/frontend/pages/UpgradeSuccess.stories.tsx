import type { Meta, StoryObj } from "@storybook/react";
import { UpgradeSuccessHero } from "./UpgradeSuccess";

const meta: Meta<typeof UpgradeSuccessHero> = {
  title: "Pages/UpgradeSuccessHero",
  component: UpgradeSuccessHero,
  args: {
    isDark: true,
    isAuthenticated: true,
    authLoading: false,
    loginUrl: "/auth/discord",
    serverId: "1234567890",
    serverName: "Engineering HQ",
    headerCopy: "Your subscription is active for Engineering HQ.",
    promoCode: "SAVE20",
    onOpenPortal: () => {},
    onOpenBilling: () => {},
    onBackToHomepage: () => {},
    plan: "pro",
    interval: "year",
  },
};

export default meta;

type Story = StoryObj<typeof UpgradeSuccessHero>;

export const Default: Story = {};

export const ConnectDiscordState: Story = {
  args: {
    isAuthenticated: false,
    serverId: "",
    serverName: "",
    headerCopy:
      "Your subscription is active and ready to power your next meeting.",
    promoCode: "",
    plan: undefined,
    interval: undefined,
  },
};
