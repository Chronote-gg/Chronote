import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import Settings from "../Settings";
import { useGuildContext } from "../../contexts/GuildContext";
import { trpc } from "../../services/trpc";

jest.mock("../../contexts/GuildContext", () => ({
  useGuildContext: jest.fn(),
}));

jest.mock("../../services/trpc", () => {
  const buildMutation = () => ({ isPending: false, mutateAsync: jest.fn() });
  const buildQuery = () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: jest.fn(),
  });
  return {
    trpc: {
      useUtils: jest.fn(() => ({})),
      autorecord: {
        list: { useQuery: jest.fn(() => buildQuery()) },
        add: { useMutation: jest.fn(() => buildMutation()) },
        remove: { useMutation: jest.fn(() => buildMutation()) },
      },
      servers: {
        channels: { useQuery: jest.fn(() => buildQuery()) },
      },
      config: {
        server: { useQuery: jest.fn(() => buildQuery()) },
        setServerOverride: { useMutation: jest.fn(() => buildMutation()) },
        clearServerOverride: { useMutation: jest.fn(() => buildMutation()) },
      },
      channelContexts: {
        list: { useQuery: jest.fn(() => buildQuery()) },
        set: { useMutation: jest.fn(() => buildMutation()) },
        clear: { useMutation: jest.fn(() => buildMutation()) },
      },
      dictionary: {
        list: { useQuery: jest.fn(() => buildQuery()) },
        upsert: { useMutation: jest.fn(() => buildMutation()) },
        remove: { useMutation: jest.fn(() => buildMutation()) },
        clear: { useMutation: jest.fn(() => buildMutation()) },
      },
      notion: {
        automationStatus: { useQuery: jest.fn(() => buildQuery()) },
        destinationPages: { useQuery: jest.fn(() => buildQuery()) },
        saveAutomationConfig: { useMutation: jest.fn(() => buildMutation()) },
        disableAutomation: { useMutation: jest.fn(() => buildMutation()) },
      },
    },
  };
});

type QueryResult = {
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: jest.Mock;
};

const buildQueryResult = (
  overrides: Partial<QueryResult> = {},
): QueryResult => ({
  data: undefined,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: jest.fn(),
  ...overrides,
});

const buildMutationResult = () => ({
  isPending: false,
  mutateAsync: jest.fn(),
});

const mockGuildContext = useGuildContext as jest.MockedFunction<
  typeof useGuildContext
>;

const trpcMock = trpc as unknown as {
  useUtils: jest.Mock;
  autorecord: {
    list: { useQuery: jest.Mock };
    add: { useMutation: jest.Mock };
    remove: { useMutation: jest.Mock };
  };
  servers: { channels: { useQuery: jest.Mock } };
  config: {
    server: { useQuery: jest.Mock };
    setServerOverride: { useMutation: jest.Mock };
    clearServerOverride: { useMutation: jest.Mock };
  };
  channelContexts: {
    list: { useQuery: jest.Mock };
    set: { useMutation: jest.Mock };
    clear: { useMutation: jest.Mock };
  };
  dictionary: {
    list: { useQuery: jest.Mock };
    upsert: { useMutation: jest.Mock };
    remove: { useMutation: jest.Mock };
    clear: { useMutation: jest.Mock };
  };
  notion: {
    automationStatus: { useQuery: jest.Mock };
    destinationPages: { useQuery: jest.Mock };
    saveAutomationConfig: { useMutation: jest.Mock };
    disableAutomation: { useMutation: jest.Mock };
  };
};

describe("Settings page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGuildContext.mockReturnValue({
      guilds: [],
      selectedGuildId: "server-1",
      setSelectedGuildId: jest.fn(),
      loading: false,
      error: null,
      refresh: jest.fn(),
    });

    trpcMock.useUtils.mockReturnValue({});
    trpcMock.autorecord.list.useQuery.mockReturnValue(buildQueryResult());
    trpcMock.servers.channels.useQuery.mockReturnValue(buildQueryResult());
    trpcMock.config.server.useQuery.mockReturnValue(
      buildQueryResult({ isLoading: true }),
    );
    trpcMock.channelContexts.list.useQuery.mockReturnValue(buildQueryResult());
    trpcMock.dictionary.list.useQuery.mockReturnValue(buildQueryResult());
    trpcMock.notion.automationStatus.useQuery.mockReturnValue(
      buildQueryResult(),
    );
    trpcMock.notion.destinationPages.useQuery.mockReturnValue(
      buildQueryResult(),
    );

    trpcMock.autorecord.add.useMutation.mockReturnValue(buildMutationResult());
    trpcMock.autorecord.remove.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.config.setServerOverride.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.config.clearServerOverride.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.channelContexts.set.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.channelContexts.clear.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.dictionary.upsert.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.dictionary.remove.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.dictionary.clear.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.notion.saveAutomationConfig.useMutation.mockReturnValue(
      buildMutationResult(),
    );
    trpcMock.notion.disableAutomation.useMutation.mockReturnValue(
      buildMutationResult(),
    );
  });

  it("shows a unified loading state during the initial fetch", () => {
    render(
      <MantineProvider>
        <Settings />
      </MantineProvider>,
    );

    expect(screen.getByText("Loading server settings...")).toBeInTheDocument();
    expect(
      screen.queryByText("No server configuration entries available."),
    ).not.toBeInTheDocument();
  });
});
