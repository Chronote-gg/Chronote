import { Profiler, type ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NotionIntegrationCard } from "./NotionIntegrationCard";
import { useAuthNavigationBlocker } from "../../hooks/useAuthNavigationBlocker";

jest.mock("../../hooks/useAuthNavigationBlocker");

test.each(["foo,bar", " foo , , bar "])(
  "saving tags %s clears the navigation blocker after confirmation",
  async (draft) => {
    const onSave = jest.fn(async () => {});
    const automation = {
      enabled: true,
      ownerConnected: true,
      destinationPageId: "fixture-page",
      channelIds: [],
      tags: [],
    };
    const props: ComponentProps<typeof NotionIntegrationCard> = {
      loading: false,
      busy: false,
      destinationPages: [],
      destinationLoading: false,
      voiceChannels: [],
      onConnect: () => {},
      onSearchDestinations: () => {},
      onSave,
      onDisable: async () => {},
      status: {
        configured: true,
        userConnected: true,
        automation,
      },
    };
    const card = (tags: string[]) => (
      <MantineProvider>
        <NotionIntegrationCard
          {...props}
          status={{
            configured: true,
            userConnected: true,
            automation: { ...automation, tags },
          }}
        />
      </MantineProvider>
    );
    const { rerender } = render(card([]));
    const input = screen.getByLabelText("Only these tags");
    fireEvent.change(input, { target: { value: draft } });
    expect(useAuthNavigationBlocker).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByText("Save Notion automation"));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ["foo", "bar"] }),
      ),
    );
    rerender(card(["foo", "bar"]));
    await waitFor(() =>
      expect(useAuthNavigationBlocker).toHaveBeenLastCalledWith(false),
    );
    expect(input).toHaveValue("foo, bar");
    fireEvent.change(input, { target: { value: "unsaved" } });
    rerender(card(["foo", "bar"]));
    expect(input).toHaveValue("unsaved");
    expect(useAuthNavigationBlocker).toHaveBeenLastCalledWith(true);
  },
);

test("an account without an automation settles after rendering", () => {
  let commits = 0;
  render(
    <MantineProvider>
      <Profiler
        id="notion"
        onRender={() => {
          if (++commits > 10) throw new Error("Notion form did not settle");
        }}
      >
        <NotionIntegrationCard
          loading={false}
          busy={false}
          destinationPages={[]}
          destinationLoading={false}
          voiceChannels={[]}
          onConnect={() => {}}
          onSearchDestinations={() => {}}
          onSave={async () => {}}
          onDisable={async () => {}}
        />
      </Profiler>
    </MantineProvider>,
  );
  expect(screen.getByText("Save Notion automation")).toBeInTheDocument();
  expect(commits).toBeLessThan(10);
});
