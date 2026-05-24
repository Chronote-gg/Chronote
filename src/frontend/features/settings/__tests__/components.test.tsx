import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { FiltersBar } from "../../library/FiltersBar";
import { GlobalDefaultsCard } from "../GlobalDefaultsCard";
import { NotionIntegrationCard } from "../NotionIntegrationCard";

describe("Settings components", () => {
  it("FiltersBar updates query", () => {
    const onQueryChange = jest.fn();
    render(
      <MantineProvider>
        <FiltersBar
          query=""
          onQueryChange={onQueryChange}
          tagOptions={["alpha"]}
          selectedTags={[]}
          onTagsChange={jest.fn()}
          selectedRange="30"
          onRangeChange={jest.fn()}
          archiveFilter="active"
          onArchiveFilterChange={jest.fn()}
          selectedChannel={null}
          onChannelChange={jest.fn()}
          channelOptions={[]}
        />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByTestId("library-search"), {
      target: { value: "hello" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("hello");
  });

  it("GlobalDefaultsCard save triggers callback", () => {
    const onSave = jest.fn();
    render(
      <MantineProvider>
        <GlobalDefaultsCard
          busy={false}
          canSave
          saving={false}
          serverContext=""
          onServerContextChange={jest.fn()}
          defaultNotesChannelId={null}
          onDefaultNotesChannelChange={jest.fn()}
          defaultTags=""
          onDefaultTagsChange={jest.fn()}
          textChannels={[]}
          defaultNotesAccess={undefined}
          globalLiveVoiceEnabled={false}
          onGlobalLiveVoiceEnabledChange={jest.fn()}
          globalLiveVoiceCommandsEnabled={false}
          onGlobalLiveVoiceCommandsEnabledChange={jest.fn()}
          globalLiveVoiceTtsVoice={null}
          onGlobalLiveVoiceTtsVoiceChange={jest.fn()}
          globalChatTtsEnabled={false}
          onGlobalChatTtsEnabledChange={jest.fn()}
          globalChatTtsVoice={null}
          onGlobalChatTtsVoiceChange={jest.fn()}
          recordAllEnabled={false}
          onRecordAllEnabledChange={jest.fn()}
          onSave={onSave}
        />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByTestId("settings-save-defaults"));
    expect(onSave).toHaveBeenCalled();
  });

  it("NotionIntegrationCard shows automation destination and disables it", () => {
    const onDisable = jest.fn(() => Promise.resolve());
    render(
      <MantineProvider>
        <NotionIntegrationCard
          status={{
            configured: true,
            userConnected: true,
            workspaceName: "Workspace One",
            automation: {
              enabled: true,
              ownerConnected: true,
              workspaceName: "Workspace One",
              destinationPageId: "page-1",
              destinationTitle: "Meeting archive",
              destinationUrl: "https://notion.so/page-1",
              channelIds: [],
              tags: [],
            },
          }}
          loading={false}
          busy={false}
          destinationPages={[]}
          destinationLoading={false}
          voiceChannels={[]}
          onConnect={jest.fn()}
          onSearchDestinations={jest.fn()}
          onSave={jest.fn(() => Promise.resolve())}
          onDisable={onDisable}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Auto-export on")).toBeInTheDocument();
    expect(screen.getAllByText(/Meeting archive/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Disable automation"));
    expect(onDisable).toHaveBeenCalled();
  });
});
