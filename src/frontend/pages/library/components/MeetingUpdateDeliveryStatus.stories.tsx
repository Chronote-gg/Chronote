import type { ComponentProps } from "react";
import { MeetingUpdateDeliveryStatus } from "./MeetingUpdateDeliveryStatus";

type Props = ComponentProps<typeof MeetingUpdateDeliveryStatus>;
const base = {
  desiredRevision: 3,
  syncedRevision: null,
  lastSuccess: { at: 1767225600, contentRevision: 2 },
};
export default {
  title: "Library/MeetingUpdateDeliveryStatus",
  tags: ["meeting-update-delivery"],
  component: MeetingUpdateDeliveryStatus,
  render: (args: Props) => (
    <div style={{ maxWidth: 640, padding: 16 }}>
      <MeetingUpdateDeliveryStatus {...args} />
    </div>
  ),
};
export const Pending = {
  args: {
    delivery: { ...base, status: "pending", reason: null, pollable: true },
  } satisfies Props,
};
export const Synced = {
  args: {
    delivery: {
      ...base,
      status: "synced",
      reason: null,
      pollable: false,
      syncedRevision: 3,
      lastSuccess: { at: 1767225600, contentRevision: 3 },
    },
  } satisfies Props,
};
export const Attention = {
  args: {
    delivery: {
      ...base,
      status: "blocked",
      reason: "retry_exhausted",
      pollable: false,
    },
  } satisfies Props,
};
export const Held = {
  args: {
    delivery: {
      ...base,
      status: "held",
      reason: "explicit_hold",
      pollable: false,
    },
  } satisfies Props,
};
export const UncertainMobile = {
  args: {
    delivery: {
      ...base,
      status: "uncertain",
      reason: "provider_outcome_unknown",
      pollable: false,
    },
  } satisfies Props,
};
export const PendingMobile = { args: Pending.args };
export const HeldTablet = { args: Held.args };
export const Unpublished = {
  args: {
    delivery: {
      ...base,
      status: "unpublished",
      reason: null,
      pollable: false,
      lastSuccess: null,
    },
  } satisfies Props,
};
