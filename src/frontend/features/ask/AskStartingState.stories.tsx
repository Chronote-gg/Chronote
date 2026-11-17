import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AskStartingState, type AskContextMeeting } from "./AskStartingState";
import { AskComposer } from "./AskComposer";
import { Pill, Stack } from "@mantine/core";

const meta: Meta<typeof AskStartingState> = {
  title: "Ask/Starting state",
  tags: ["ask-starting"],
  component: AskStartingState,
  args: {
    count: 8,
    meetings: [
      { id: "1", title: "Product planning", timestamp: "2026-11-16T14:00:00Z" },
      {
        id: "2",
        title: "Weekly team catch-up",
        timestamp: "2026-11-15T14:00:00Z",
      },
      { id: "3", title: "Launch review", timestamp: "2026-11-14T14:00:00Z" },
    ],
    loading: false,
    failed: false,
    selectedIds: [],
    onSelect: () => undefined,
    onExample: () => undefined,
    onRetry: () => undefined,
  },
  render: (args) => {
    const [selected, setSelected] = useState<AskContextMeeting[]>([]);
    const [draft, setDraft] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    return (
      <Stack maw={760} p="md">
        <AskStartingState
          {...args}
          selectedIds={selected.map((meeting) => meeting.id)}
          onSelect={(meeting) => setSelected([...selected, meeting])}
          onExample={(question) => {
            setDraft(question);
            inputRef.current?.focus();
          }}
        />
        <AskComposer
          listMode="mine"
          isArchived={false}
          askAccessAllowed
          selectedGuildId="guild"
          draft={draft}
          onDraftChange={setDraft}
          onAsk={() => undefined}
          askPending={false}
          errorMessage={null}
          inputRef={inputRef}
          contextChips={
            <Pill.Group>
              {selected.map((meeting) => (
                <Pill
                  key={meeting.id}
                  withRemoveButton
                  onRemove={() =>
                    setSelected(
                      selected.filter((item) => item.id !== meeting.id),
                    )
                  }
                >
                  {meeting.title}
                </Pill>
              ))}
            </Pill.Group>
          }
        />
      </Stack>
    );
  },
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { count: 0, meetings: [] } };
export const Loading: Story = {
  args: { count: undefined, loading: true, meetings: [] },
};
export const Failed: Story = {
  args: { count: undefined, failed: true, meetings: [] },
};
export const NotesPending: Story = { args: { count: 2, meetings: [] } };
export const Mobile: Story = {};

export const SearchPending: Story = {
  args: {
    searchQuery: "planning",
    onSearchChange: () => undefined,
    coverage: "partial",
    count: undefined,
  },
};
