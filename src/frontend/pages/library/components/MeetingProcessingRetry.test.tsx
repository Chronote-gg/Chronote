import type { ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MeetingProcessingRetry } from "./MeetingProcessingRetry";

type Props = ComponentProps<typeof MeetingProcessingRetry>;

const eligible: Props["view"] = {
  eligible: true,
  requiresReplaceConfirm: false,
  attemptsRemaining: 3,
};

const renderRetry = (patch: Partial<Props> = {}) => {
  const onRetry = jest.fn();
  const result = render(
    <MantineProvider>
      <MeetingProcessingRetry
        view={eligible}
        pending={false}
        onRetry={onRetry}
        notes=""
        {...patch}
      />
    </MantineProvider>,
  );
  return { onRetry, container: result.container };
};

const openModal = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry processing" }));
  });
  return screen.findByRole("dialog", { name: "Retry processing?" });
};

describe("MeetingProcessingRetry", () => {
  it("confirming a plain retry calls onRetry(false)", async () => {
    const { onRetry } = renderRetry();
    await openModal();
    expect(
      screen.getByText(
        "Chronote will re-run the steps that failed and update this meeting and its Discord posts.",
      ),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(onRetry).toHaveBeenCalledWith(false);
  });

  it("replacing notes stays disabled until the replace checkbox is checked, then calls onRetry(true)", async () => {
    const { onRetry } = renderRetry({
      view: { ...eligible, requiresReplaceConfirm: true },
    });
    await openModal();
    expect(
      screen.getByText(
        "This replaces the current notes with newly generated notes.",
      ),
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Retry" });
    expect(confirm).toBeDisabled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Replace the current notes" }),
      );
    });
    expect(confirm).toBeEnabled();
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onRetry).toHaveBeenCalledWith(true);
  });

  it("shows progress while queued", () => {
    renderRetry({
      view: {
        ...eligible,
        eligible: false,
        reason: "job_active",
        status: "queued",
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Retrying processing. This can take a few minutes.",
    );
    expect(
      screen.queryByRole("button", { name: "Retry processing" }),
    ).not.toBeInTheDocument();
  });

  it("shows the failure reason and attempts left", () => {
    renderRetry({
      view: {
        ...eligible,
        status: "failed",
        failureReason: "notes_changed",
        attemptsRemaining: 2,
      },
    });
    expect(
      screen.getByText(
        "The notes changed while the retry ran, so nothing was saved. 2 attempts left.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry processing" }),
    ).toBeInTheDocument();
  });

  it("says when current settings were used", () => {
    renderRetry({
      view: {
        ...eligible,
        eligible: false,
        reason: "nothing_failed",
        status: "succeeded",
        settingsSource: "current",
      },
    });
    expect(
      screen.getByText("This retry used the server's current settings."),
    ).toBeInTheDocument();
  });

  it("renders nothing for nothing_failed", () => {
    const { container } = renderRetry({
      view: { ...eligible, eligible: false, reason: "nothing_failed" },
    });
    // MantineProvider injects its CSS variables as a style element.
    expect(container.querySelectorAll(":scope > :not(style)")).toHaveLength(0);
  });

  it("shows the portal summary notice for a summary-only failure", () => {
    renderRetry({
      view: { ...eligible, eligible: false, reason: "unavailable" },
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "failed",
      },
      notes: "Generated notes",
    });
    expect(
      screen.getByText(
        "The summary could not be generated for this recording.",
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing for not_permitted, even with a summary failure", () => {
    const { container } = renderRetry({
      view: {
        eligible: false,
        reason: "not_permitted",
        requiresReplaceConfirm: false,
        attemptsRemaining: 0,
      },
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "failed",
      },
      notes: "Generated notes",
    });
    expect(container.querySelectorAll(":scope > :not(style)")).toHaveLength(0);
  });

  it("does not spin for a queued job while retry is unavailable", () => {
    renderRetry({
      view: {
        ...eligible,
        eligible: false,
        reason: "unavailable",
        status: "queued",
      },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the attempts count with its word", () => {
    renderRetry({
      view: {
        ...eligible,
        status: "failed",
        failureReason: "stage_failed",
        attemptsRemaining: 2,
      },
    });
    expect(screen.getByText(/attempts left/).textContent).toBe(
      "The retry could not finish. Nothing was changed. 2\u00a0attempts left.",
    );
  });
});
