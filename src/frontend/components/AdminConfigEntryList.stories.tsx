import { useState } from "react";
import { Box } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { CONFIG_KEYS } from "../../config/keys";
import { getConfigEntry } from "../../config/registry";
import { AdminConfigEntryList } from "./AdminConfigEntryList";
import type { ConfigMode } from "./AdminConfigEntryCard";

const key = CONFIG_KEYS.transcription.speechDetectionMode;
const entry = getConfigEntry(key);
if (!entry) throw new Error("Speech detection config entry is missing");
const defaultValue = entry.defaultValue;
const entries = [entry];
const valuesByKey = new Map([
  [key, { value: entry.defaultValue, source: "default" }],
]);
function SpeechDetectionConfig() {
  const [localValues, setValues] = useState<Record<string, unknown>>({
    [key]: defaultValue,
  });
  const [localModes, setModes] = useState<Record<string, ConfigMode>>({
    [key]: "default",
  });
  return (
    <Box p="md" maw={920}>
      <AdminConfigEntryList
        entries={entries}
        valuesByKey={valuesByKey}
        localValues={localValues}
        localModes={localModes}
        disabled={false}
        onModeChange={setModes}
        onValueChange={setValues}
        onDirty={() => {}}
      />
    </Box>
  );
}
const meta = {
  title: "Admin/Speech detection config",
  component: SpeechDetectionConfig,
  tags: ["vad-config"],
} satisfies Meta<typeof SpeechDetectionConfig>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Experimental" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      canvas.queryByRole("combobox", { name: key }),
    ).not.toBeInTheDocument();
  },
};
export const InheritedAndReset: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Experimental" }));
    const input = await canvas.findByRole("combobox", { name: key });
    await expect(input).toHaveValue("Off");
    await expect(
      canvas.getByText("Status: Inherited from Default"),
    ).toBeVisible();
    await expect(
      canvas.getByText("Global: required / superadmin / select"),
    ).toBeVisible();
    await expect(canvas.getByText("Server: disabled")).toBeVisible();
    await userEvent.click(input);
    const page = within(canvasElement.ownerDocument.body);
    await expect(
      page.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Off", "Shadow", "Enforce"]);
    await userEvent.click(page.getByRole("option", { name: "Enforce" }));
    await expect(input).toHaveValue("Enforce");
    await expect(canvas.getByText("Status: Overridden")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Reset" }));
    await expect(input).toHaveValue("Off");
    await expect(
      canvas.getByText("Status: Inherited from Default"),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Reset" }),
    ).not.toBeInTheDocument();
  },
};
export const ModeOptions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Experimental" }));
    await userEvent.click(await canvas.findByRole("combobox", { name: key }));
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("option", {
        name: "Shadow",
      }),
    ).toBeVisible();
  },
};
export const Overridden: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Experimental" }));
    await userEvent.click(await canvas.findByRole("combobox", { name: key }));
    await userEvent.click(
      within(canvasElement.ownerDocument.body).getByRole("option", {
        name: "Shadow",
      }),
    );
    await expect(canvas.getByText("Status: Overridden")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Reset" })).toBeVisible();
  },
};
