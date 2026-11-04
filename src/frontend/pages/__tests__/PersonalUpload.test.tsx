import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import PersonalUpload from "../PersonalUpload";

const mockNavigate = jest.fn();
const mockCreateUploadIntentMutation = jest.fn();
const mockCompleteUploadMutation = jest.fn();
const mockGetStatusQuery = jest.fn();

jest.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock("@mantine/notifications", () => ({
  notifications: { show: jest.fn() },
}));

jest.mock("../../services/trpc", () => ({
  trpc: {
    personalUploads: {
      createUploadIntent: {
        useMutation: () => mockCreateUploadIntentMutation(),
      },
      completeUpload: { useMutation: () => mockCompleteUploadMutation() },
      getStatus: {
        useQuery: (...args: unknown[]) => mockGetStatusQuery(...args),
      },
    },
  },
}));

const renderPage = () =>
  render(
    <MantineProvider>
      <PersonalUpload />
    </MantineProvider>,
  );

describe("PersonalUpload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateUploadIntentMutation.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockCompleteUploadMutation.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
      data: null,
      reset: jest.fn(),
    });
    mockGetStatusQuery.mockReturnValue({
      data: null,
      refetch: jest.fn(),
    });
  });

  it("rejects unsupported files before requesting an upload intent", async () => {
    const mutateAsync = jest.fn();
    mockCreateUploadIntentMutation.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
    renderPage();

    fireEvent.change(screen.getByTestId("personal-upload-file-input"), {
      target: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });
    fireEvent.click(screen.getByTestId("personal-upload-submit"));

    expect(
      await screen.findByTestId("personal-upload-error"),
    ).toHaveTextContent("Choose a supported audio or video file.");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("opens the completed personal meeting route", () => {
    mockGetStatusQuery.mockReturnValue({
      data: {
        job: {
          status: "complete",
          meetingGuildId: "personal:user-1",
          channelId_timestamp: "personal#2026-01-01T00:00:00.000Z",
        },
      },
      refetch: jest.fn(),
    });
    renderPage();

    fireEvent.click(screen.getByTestId("personal-upload-open-meeting"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/meetings",
      search: expect.objectContaining({
        scope: "personal",
        meetingServerId: "personal:user-1",
        meetingId: "personal#2026-01-01T00:00:00.000Z",
      }),
    });
  });

  it("shows a paused draft without polling or success and requires a separately chosen file", async () => {
    jest.useFakeTimers();
    const refetch = jest.fn();
    const reset = jest.fn();
    const job = {
      status: "paused",
      retryable: false,
      errorMessage:
        "This draft is preserved and paused. Recovery is not available yet.",
    };
    mockCreateUploadIntentMutation.mockReturnValue({
      isPending: false,
      mutateAsync: jest.fn().mockResolvedValue({
        uploadId: "original-upload",
        key: "original-key",
        uploadToken: "test-token",
        upload: { url: "http://localhost/upload", fields: {} },
      }),
    });
    mockCompleteUploadMutation.mockReturnValue({
      isPending: false,
      data: { job },
      reset,
      mutateAsync: jest.fn().mockResolvedValue({ job }),
    });
    mockGetStatusQuery.mockReturnValue({ data: { job }, refetch });
    jest
      .spyOn(XMLHttpRequest.prototype, "open")
      .mockImplementation(() => undefined);
    jest.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(204);
    jest.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
      this: XMLHttpRequest,
    ) {
      this.onload?.(new ProgressEvent("load"));
    });
    try {
      renderPage();
      expect(screen.getByText(job.errorMessage)).toBeVisible();
      expect(screen.getByTestId("personal-upload-submit")).toBeDisabled();
      fireEvent.change(screen.getByTestId("personal-upload-file-input"), {
        target: {
          files: [new File(["audio"], "new.wav", { type: "audio/wav" })],
        },
      });
      expect(reset).toHaveBeenCalledTimes(1);
      // The next query and mutation represent the independently chosen upload.
      mockGetStatusQuery.mockReturnValue({ data: null, refetch });
      mockCompleteUploadMutation.mockReturnValue({
        isPending: false,
        data: null,
        reset,
        mutateAsync: jest.fn().mockImplementation(async () => {
          mockGetStatusQuery.mockReturnValue({ data: { job }, refetch });
          return { job };
        }),
      });
      fireEvent.change(screen.getByTestId("personal-upload-title"), {
        target: { value: "New recording" },
      });
      fireEvent.click(screen.getByTestId("personal-upload-submit"));
      await waitFor(() =>
        expect(screen.getByTestId("personal-upload-error")).toHaveTextContent(
          job.errorMessage,
        ),
      );
      expect(notifications.show).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(15_000));
      expect(refetch).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });
});
