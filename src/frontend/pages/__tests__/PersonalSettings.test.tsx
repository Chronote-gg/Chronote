import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import PersonalSettings from "../PersonalSettings";

const mockUseAuth = jest.fn();
const mockNotionAutomationStatusUseQuery = jest.fn();
const mockNotionDestinationPagesUseQuery = jest.fn();
const mockSaveNotionAutomationUseMutation = jest.fn();
const mockDisableNotionAutomationUseMutation = jest.fn();
const mockNotionAutomationStatusInvalidate = jest.fn();

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("../../services/trpc", () => ({
  trpc: {
    useUtils: () => ({
      notion: {
        automationStatus: { invalidate: mockNotionAutomationStatusInvalidate },
      },
    }),
    notion: {
      automationStatus: {
        useQuery: (...args: unknown[]) =>
          mockNotionAutomationStatusUseQuery(...args),
      },
      destinationPages: {
        useQuery: (...args: unknown[]) =>
          mockNotionDestinationPagesUseQuery(...args),
      },
      saveAutomationConfig: {
        useMutation: (...args: unknown[]) =>
          mockSaveNotionAutomationUseMutation(...args),
      },
      disableAutomation: {
        useMutation: (...args: unknown[]) =>
          mockDisableNotionAutomationUseMutation(...args),
      },
    },
  },
}));

const renderPage = () =>
  render(
    <MantineProvider>
      <PersonalSettings />
    </MantineProvider>,
  );

describe("PersonalSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { id: "user-1", username: "User" } });
    mockNotionAutomationStatusUseQuery.mockReturnValue({
      data: { configured: true, userConnected: false },
      isLoading: false,
      isFetching: false,
    });
    mockNotionDestinationPagesUseQuery.mockReturnValue({
      data: { pages: [] },
      isLoading: false,
      isFetching: false,
      refetch: jest.fn(),
    });
    mockSaveNotionAutomationUseMutation.mockReturnValue({
      isPending: false,
      mutateAsync: jest.fn(),
    });
    mockDisableNotionAutomationUseMutation.mockReturnValue({
      isPending: false,
      mutateAsync: jest.fn(),
    });
  });

  it("loads personal Notion automation under the authenticated user's scope", () => {
    renderPage();

    expect(screen.getByTestId("personal-settings-page")).toBeInTheDocument();
    expect(mockNotionAutomationStatusUseQuery).toHaveBeenCalledWith(
      { serverId: "personal:user-1" },
      { enabled: true },
    );
    expect(
      screen.getByText(
        "Export personal meeting notes to your Notion page destination.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Only these voice channels")).toBeNull();
  });
});
