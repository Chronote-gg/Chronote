import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MeetingSummaryPanel } from "./MeetingSummaryPanel";

const renderPanel = (
  props?: Partial<ComponentProps<typeof MeetingSummaryPanel>>,
) => {
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
        {...props}
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

describe("MeetingSummaryPanel processing notices", () => {
  it("shows the empty explanation and disables generated-note actions", async () => {
    renderPanel({
      summary: "",
      notes: "",
      processing: { transcription: "empty", notes: "skipped" },
      onEditNotes: jest.fn(),
      onImportNotes: jest.fn(),
      onSuggestCorrection: jest.fn(),
      notionActionLabel: "Export to Notion",
      onNotionAction: jest.fn(),
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "No usable speech was found, so no notes were generated.",
    );
    expect(screen.queryByText("No notes recorded.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Copy summary as Markdown")).toBeDisabled();
    expect(screen.getByLabelText("Mark summary helpful")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Notes actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Edit notes" }),
    ).toBeEnabled();
    expect(
      screen.getByText("Import notes").closest("[role=menuitem]"),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Suggest correction (AI)",
        hidden: true,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Export to Notion", hidden: true }),
    ).toBeDisabled();
  });

  it("shows partial notes with the exact warning", () => {
    renderPanel({
      notes: "Notes from the surviving transcript.",
      processing: { transcription: "partial", notes: "generated" },
    });

    expect(
      screen.getByText("Notes from the surviving transcript."),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some audio could not be transcribed. These notes may be incomplete.",
    );
  });

  it.each([
    [
      { transcription: "failed" as const, notes: "skipped" as const },
      "Audio could not be transcribed, so no notes were generated.",
    ],
    [
      { transcription: "ready" as const, notes: "failed" as const },
      "Notes could not be generated for this recording.",
    ],
  ])("shows a failed processing notice", (processing, text) => {
    renderPanel({ summary: "", notes: "", processing });
    expect(screen.getByRole("alert")).toHaveTextContent(text);
  });

  it("hides an empty explanation after notes are imported", () => {
    renderPanel({
      notes: "Manually imported notes",
      processing: { transcription: "empty", notes: "skipped" },
    });
    expect(screen.getByText("Manually imported notes")).toBeVisible();
    expect(
      screen.queryByText(
        "No usable speech was found, so no notes were generated.",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps the legacy fallback visible", () => {
    renderPanel({ notes: "No notes recorded." });
    expect(screen.getByText("No notes recorded.")).toBeVisible();
  });
});
