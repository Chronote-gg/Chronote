import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  ServiceAccountsCard,
  type ServiceAccountSummary,
} from "../ServiceAccountsCard";

const account: ServiceAccountSummary = {
  tokenId: "11111111-1111-1111-1111-111111111111",
  botUserId: "100000000000000001",
  name: "Ops agent",
  scopes: ["meetings:read"],
  channelIds: ["voice-1"],
  createdAt: "2026-07-01T00:00:00.000Z",
};

const baseProps = {
  accounts: [] as ServiceAccountSummary[],
  loading: false,
  busy: false,
  canCreate: true,
  voiceChannels: [
    {
      value: "voice-1",
      label: "Weekly sync",
      botAccess: true,
      missingPermissions: [],
    },
  ],
  onCreate: jest.fn(async () => "cnsa_secret"),
  onRevoke: jest.fn(async () => undefined),
};

const renderCard = (props: Partial<typeof baseProps> = {}) =>
  render(
    <MantineProvider>
      <ServiceAccountsCard {...baseProps} {...props} />
    </MantineProvider>,
  );

describe("ServiceAccountsCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("blocks creation for a non-administrator", () => {
    renderCard({ canCreate: false });

    expect(
      screen.getByRole("button", { name: /new service account/i }),
    ).toBeDisabled();
  });

  it("resolves an allowlisted channel id to its name", () => {
    renderCard({ accounts: [account] });

    expect(screen.getByText(/Limited to Weekly sync/)).toBeInTheDocument();
  });

  it("says so when a token is not limited to channels", () => {
    renderCard({ accounts: [{ ...account, channelIds: undefined }] });

    expect(
      screen.getByText(/All channels the bot can reach/),
    ).toBeInTheDocument();
  });

  const openCreateModal = async () => {
    fireEvent.click(
      screen.getByRole("button", { name: /new service account/i }),
    );
    return {
      botUserId: await screen.findByLabelText(/Bot user ID/i),
      name: await screen.findByLabelText(/^Name$/i),
      submit: await screen.findByRole("button", { name: "Create" }),
    };
  };

  it("requires a Discord id and a name before creating", async () => {
    renderCard();
    const form = await openCreateModal();

    expect(form.submit).toBeDisabled();

    fireEvent.change(form.botUserId, { target: { value: "not-an-id" } });
    expect(screen.getByText(/Expected a Discord user ID/)).toBeInTheDocument();
    expect(form.submit).toBeDisabled();

    fireEvent.change(form.botUserId, {
      target: { value: "100000000000000009" },
    });
    fireEvent.change(form.name, { target: { value: "Agent" } });
    expect(form.submit).toBeEnabled();
  });

  it("shows the raw token once and never re-renders it after closing", async () => {
    renderCard();
    const form = await openCreateModal();
    fireEvent.change(form.botUserId, {
      target: { value: "100000000000000009" },
    });
    fireEvent.change(form.name, { target: { value: "Agent" } });
    fireEvent.click(form.submit);

    await waitFor(() =>
      expect(screen.getByTestId("service-account-token")).toHaveTextContent(
        "cnsa_secret",
      ),
    );
    expect(baseProps.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        botUserId: "100000000000000009",
        name: "Agent",
        scopes: ["meetings:read"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(
        screen.queryByTestId("service-account-token"),
      ).not.toBeInTheDocument(),
    );
  });

  it("always pairs transcript access with meetings:read", async () => {
    // A transcripts-only token would mint fine and then be unable to call
    // anything, because every transcript tool also requires meetings:read.
    renderCard();
    const form = await openCreateModal();
    fireEvent.change(form.botUserId, {
      target: { value: "100000000000000009" },
    });
    fireEvent.change(form.name, { target: { value: "Agent" } });
    fireEvent.click(screen.getByLabelText(/Also allow reading transcripts/i));
    fireEvent.click(form.submit);

    await waitFor(() =>
      expect(baseProps.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ["meetings:read", "transcripts:read"],
        }),
      ),
    );
  });

  it("revokes by token id", async () => {
    renderCard({ accounts: [account] });
    fireEvent.click(screen.getByRole("button", { name: /Revoke Ops agent/i }));

    await waitFor(() =>
      expect(baseProps.onRevoke).toHaveBeenCalledWith(account.tokenId),
    );
  });
});
