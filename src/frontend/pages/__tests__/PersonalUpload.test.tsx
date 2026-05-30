import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
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
      to: "/portal/meetings/$serverId/$meetingId",
      params: {
        serverId: "personal:user-1",
        meetingId: "personal#2026-01-01T00:00:00.000Z",
      },
    });
  });
});
