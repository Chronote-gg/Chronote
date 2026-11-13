import type { Meta, StoryObj } from "@storybook/react";
import { AuthRecoveryView } from "./ProtectedSessionBoundary";

const meta: Meta<typeof AuthRecoveryView> = {
  title: "Auth/Session recovery",
  tags: ["auth-recovery"],
  component: AuthRecoveryView,
  args: {
    phase: "checking",
    onRetry: () => {},
    onSignIn: () => {},
    onStay: () => {},
  },
};
export default meta;
type Story = StoryObj<typeof AuthRecoveryView>;
export const Checking: Story = {};
export const ReturningThroughDiscord: Story = {
  args: { phase: "redirecting" },
};
export const Unavailable: Story = { args: { phase: "unavailable" } };
export const ExplicitRecovery: Story = { args: { phase: "required" } };
export const UnfinishedWork: Story = { args: { phase: "blocked" } };
export const UnfinishedWorkMobile: Story = { args: { phase: "blocked" } };
