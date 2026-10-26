import {
  useMeetingDetailMock,
  buildMeeting,
  buildDetail,
  buildUseMeetingDetailResult,
  renderDrawer,
  mockUpdateNotes,
  mockImportNotes,
  mockRename,
  applyCorrection,
  resetDrawerFixtures,
} from "./MeetingDetailDrawer.fixture";
import { notifications } from "@mantine/notifications";
import { screen, fireEvent, waitFor } from "@testing-library/react";
describe("MeetingDetailDrawer delivery", () => {
  const writeTextMock = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => resetDrawerFixtures(writeTextMock));
  it.each([
    [
      { status: "pending", reason: null, pollable: true },
      "Saved. Updating Discord.",
    ],
    [
      { status: "synced", reason: null, pollable: false },
      "Saved. Discord is up to date.",
    ],
    [
      { status: "blocked", reason: "retry_exhausted", pollable: false },
      "Saved. Discord update needs attention.",
    ],
    [
      { status: "held", reason: "explicit_hold", pollable: false },
      "Saved. Publication is on hold.",
    ],
  ] as const)("renders actual safe delivery state %s", (state, copy) => {
    const updateDelivery = {
      ...state,
      desiredRevision: 3,
      syncedRevision: state.status === "synced" ? 3 : null,
      lastSuccess: { at: 1767225600, contentRevision: 2 },
    };
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ updateDelivery }),
        meeting: buildMeeting({ updateDelivery }),
      }),
    );
    renderDrawer();
    expect(screen.getByText(copy)).toBeVisible();
    expect(screen.getByText(/Revision 3/)).toBeVisible();
    if (state.status !== "synced")
      expect(
        screen.queryByText("Saved. Discord is up to date."),
      ).not.toBeInTheDocument();
  });

  it.each(["edit", "import"] as const)(
    "consumes the %s acknowledgment before a detail refresh",
    async (action) => {
      renderDrawer();
      fireEvent.click(screen.getByLabelText("Notes actions"));
      fireEvent.click(
        await screen.findByText(
          action === "edit" ? "Edit notes" : "Import notes",
        ),
      );
      fireEvent.click(
        await screen.findByText(
          action === "edit"
            ? "Confirm synthetic edit"
            : "Confirm synthetic import",
        ),
      );
      expect(await screen.findByText("Saved. Updating Discord.")).toBeVisible();
      expect(
        screen.queryByText("Saved. Discord is up to date."),
      ).not.toBeInTheDocument();
      expect(
        action === "edit" ? mockUpdateNotes : mockImportNotes,
      ).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps a conflicting save out of saved status", async () => {
    mockUpdateNotes.mockRejectedValueOnce(
      Object.assign(new Error("Refresh and try again."), {
        data: { code: "CONFLICT" },
      }),
    );
    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));
    fireEvent.click(await screen.findByText("Edit notes"));
    fireEvent.click(await screen.findByText("Confirm synthetic edit"));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red" }),
      ),
    );
    expect(
      screen.queryByTestId("meeting-update-delivery"),
    ).not.toBeInTheDocument();
  });
  it("consumes rename acknowledgment without inventing an ok field", async () => {
    renderDrawer();
    fireEvent.click(screen.getByLabelText("Rename meeting"));
    fireEvent.change(await screen.findByTestId("meeting-rename-input"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Saved. Updating Discord.")).toBeVisible();
    expect(mockRename).toHaveBeenCalledTimes(1);
  });
  it("consumes correction acknowledgment and retains its teaching offer", async () => {
    renderDrawer();
    await applyCorrection();
    expect(await screen.findByText("Saved. Updating Discord.")).toBeVisible();
  });
});
