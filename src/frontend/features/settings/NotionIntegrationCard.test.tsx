import { Profiler } from "react";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NotionIntegrationCard } from "./NotionIntegrationCard";

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
