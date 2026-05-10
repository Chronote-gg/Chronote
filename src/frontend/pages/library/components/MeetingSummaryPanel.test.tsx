import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MeetingSummaryPanel } from "./MeetingSummaryPanel";

const renderPanel = (props?: {
  notionActionLabel?: string;
  notionPageUrl?: string;
  onNotionAction?: jest.Mock;
  onOpenNotionPage?: jest.Mock;
}) => {
  render(
    <MantineProvider>
      <MeetingSummaryPanel
        summary="Summary"
        notes="Notes"
        summaryFeedback={null}
        feedbackPending={false}
        copyDisabled={false}
        onFeedbackUp={jest.fn()}
        onFeedbackDown={jest.fn()}
        onCopySummary={jest.fn()}
        notionActionLabel={props?.notionActionLabel}
        notionPageUrl={props?.notionPageUrl}
        onNotionAction={props?.onNotionAction}
        onOpenNotionPage={props?.onOpenNotionPage}
      />
    </MantineProvider>,
  );
};

describe("MeetingSummaryPanel Notion actions", () => {
  it("renders and runs the configured Notion action", async () => {
    const onNotionAction = jest.fn();
    renderPanel({ notionActionLabel: "Export to Notion", onNotionAction });

    fireEvent.click(screen.getByRole("button", { name: "Notes actions" }));
    fireEvent.click(await screen.findByText("Export to Notion"));

    expect(onNotionAction).toHaveBeenCalledTimes(1);
  });

  it("renders the open page action when a Notion page exists", async () => {
    const onOpenNotionPage = jest.fn();
    renderPanel({
      notionPageUrl: "https://notion.so/page-1",
      onOpenNotionPage,
    });

    fireEvent.click(screen.getByRole("button", { name: "Notes actions" }));
    fireEvent.click(await screen.findByText("Open Notion page"));

    expect(onOpenNotionPage).toHaveBeenCalledTimes(1);
  });
});
