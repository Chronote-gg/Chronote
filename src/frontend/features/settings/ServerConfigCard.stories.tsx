import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { CONFIG_KEYS } from "../../../config/keys";
import { getConfigEntry } from "../../../config/registry";
import { ServerConfigCard } from "./ServerConfigCard";

const key = CONFIG_KEYS.meetings.attendeeAccessEnabled;
const entry = getConfigEntry(key);
if (!entry) throw new Error("Attendee access config entry is missing");

const meta = {
  title: "Settings/Attendee access",
  component: ServerConfigCard,
  tags: ["attendee-access"],
  render: function AttendeeAccessSettings(args) {
    const [overrides, setOverrides] = useState(args.overrides);
    return (
      <ServerConfigCard
        {...args}
        overrides={overrides}
        onSet={async (configKey, value) => {
          await args.onSet(configKey, value);
          setOverrides([{ configKey, value }]);
        }}
        onClear={async (configKey) => {
          await args.onClear(configKey);
          setOverrides([]);
        }}
      />
    );
  },
  args: {
    busy: false,
    registry: [entry],
    snapshot: {
      values: { [key]: { key, value: entry.defaultValue, source: "default" } },
      experimentalEnabled: false,
      tier: "free",
      missingRequired: [],
    },
    overrides: [],
    onSet: fn(async () => {}),
    onClear: fn(async () => {}),
  },
} satisfies Meta<typeof ServerConfigCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultOn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Attendee access")).toBeVisible();
    await expect(canvas.getByRole("radio", { name: /^On$/ })).toBeChecked();
    await expect(canvas.getByText("Status: Default")).toBeVisible();
  },
};

export const ServerOptOut: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /^Off$/ }));
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Save settings" })[0],
    );
    await expect(args.onSet).toHaveBeenCalledWith(key, false);
    await expect(canvas.getByRole("radio", { name: /^Off$/ })).toBeChecked();
  },
};
