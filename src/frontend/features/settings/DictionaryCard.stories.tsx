import type { Meta, StoryObj } from "@storybook/react";
import { DictionaryCard } from "./DictionaryCard";

const meta: Meta<typeof DictionaryCard> = {
  title: "Settings/DictionaryCard",
  component: DictionaryCard,
  args: {
    busy: false,
    entries: [],
    budgets: {
      maxEntries: 50,
      maxCharsTranscription: 1_500,
      maxCharsContext: 4_000,
    },
    onUpsert: async () => undefined,
    onRemove: async () => undefined,
    onClear: async () => undefined,
    onTeach: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof DictionaryCard>;

export const Empty: Story = {};

export const WithTerms: Story = {
  args: {
    entries: [
      {
        guildId: "server-1",
        termKey: "jon smythe",
        term: "Jon Smythe",
        definition: "Apollo project collaborator",
        observedForms: ["John Smith"],
        createdAt: "2026-08-26T12:00:00.000Z",
        createdBy: "user-1",
      },
      {
        guildId: "server-1",
        termKey: "chronote",
        term: "Chronote",
        definition: "Meeting transcription and notes assistant",
        createdAt: "2026-08-26T12:00:00.000Z",
        createdBy: "user-1",
      },
    ],
  },
};
