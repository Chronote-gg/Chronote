import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import DictionaryTeachingModal from "../DictionaryTeachingModal";

const mockPreviewTeaching = jest.fn();
const mockCommitTeaching = jest.fn();

jest.mock("../../../services/trpc", () => ({
  trpc: {
    dictionary: {
      previewTeaching: {
        useMutation: () => ({
          mutateAsync: mockPreviewTeaching,
          isPending: false,
        }),
      },
      commitTeaching: {
        useMutation: () => ({
          mutateAsync: mockCommitTeaching,
          isPending: false,
        }),
      },
    },
  },
}));

jest.mock("@mantine/notifications", () => ({
  notifications: {
    show: jest.fn(),
  },
}));

const renderModal = (props?: {
  initialInstruction?: string;
  correctionContextToken?: string;
  onSaved?: jest.Mock;
}) =>
  render(
    <MantineProvider>
      <DictionaryTeachingModal
        opened
        serverId="guild-1"
        initialInstruction={props?.initialInstruction}
        correctionContextToken={props?.correctionContextToken}
        onClose={jest.fn()}
        onSaved={props?.onSaved}
      />
    </MantineProvider>,
  );

describe("DictionaryTeachingModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPreviewTeaching.mockResolvedValue({
      token: "11111111-1111-4111-8111-111111111111",
      expiresAtMs: Date.now() + 15 * 60 * 1_000,
      drafts: [
        {
          draftId: "22222222-2222-4222-8222-222222222222",
          preferredTerm: "Jon Smythe",
          observedForms: ["John Smith"],
          description: "Apollo project collaborator",
          ambiguity: null,
          evidence: [
            {
              source: "instruction",
              quote: "his name is Jon Smythe",
            },
          ],
          action: "create",
        },
      ],
    });
    mockCommitTeaching.mockResolvedValue({
      results: [
        {
          draftId: "22222222-2222-4222-8222-222222222222",
          ok: true,
        },
      ],
    });
  });

  it("turns natural-language guidance into an editable approval step", async () => {
    const onSaved = jest.fn();
    renderModal({
      initialInstruction:
        "It wrote John Smith, but his name is Jon Smythe. He works on Apollo.",
      correctionContextToken: "33333333-3333-4333-8333-333333333333",
      onSaved,
    });

    fireEvent.click(screen.getByRole("button", { name: "Review terms" }));

    await waitFor(() =>
      expect(mockPreviewTeaching).toHaveBeenCalledWith({
        serverId: "guild-1",
        instruction:
          "It wrote John Smith, but his name is Jon Smythe. He works on Apollo.",
        correctionContextToken: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(await screen.findByDisplayValue("Jon Smythe")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Apollo project collaborator"),
    ).toBeInTheDocument();
    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "John Smith" })).toHaveClass(
      "ph-no-capture",
    );

    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "Apollo deployment partner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Teach Chronote" }));

    await waitFor(() =>
      expect(mockCommitTeaching).toHaveBeenCalledWith({
        serverId: "guild-1",
        token: "11111111-1111-4111-8111-111111111111",
        entries: [
          {
            draftId: "22222222-2222-4222-8222-222222222222",
            preferredTerm: "Jon Smythe",
            observedForms: ["John Smith"],
            description: "Apollo deployment partner",
          },
        ],
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("does not preselect ambiguous terms without exact spelling", async () => {
    mockPreviewTeaching.mockResolvedValue({
      token: "11111111-1111-4111-8111-111111111111",
      expiresAtMs: Date.now() + 15 * 60 * 1_000,
      drafts: [
        {
          draftId: "22222222-2222-4222-8222-222222222222",
          preferredTerm: null,
          observedForms: ["maybe name"],
          description: null,
          ambiguity: "Provide the exact spelling.",
          evidence: [],
          action: "needs_input",
        },
      ],
    });
    renderModal({ initialInstruction: "That person's name was wrong." });

    fireEvent.click(screen.getByRole("button", { name: "Review terms" }));

    expect(await screen.findByText("Needs exact spelling")).toBeInTheDocument();
    expect(screen.getByLabelText("Save this term")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Teach Chronote" }),
    ).toBeDisabled();
  });

  it("submits an empty description so an existing description can be cleared", async () => {
    renderModal({ initialInstruction: "Update Jon Smythe." });
    fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
    const description = await screen.findByLabelText("Description (optional)");
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Teach Chronote" }));

    await waitFor(() =>
      expect(mockCommitTeaching).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: [expect.objectContaining({ description: "" })],
        }),
      ),
    );
  });

  it("removes successful drafts before retrying a partial save", async () => {
    const onSaved = jest.fn();
    mockPreviewTeaching.mockResolvedValue({
      token: "11111111-1111-4111-8111-111111111111",
      expiresAtMs: Date.now() + 15 * 60 * 1_000,
      drafts: [
        {
          draftId: "22222222-2222-4222-8222-222222222222",
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
        {
          draftId: "33333333-3333-4333-8333-333333333333",
          preferredTerm: "Apollo",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
    });
    mockCommitTeaching.mockResolvedValue({
      results: [
        {
          draftId: "22222222-2222-4222-8222-222222222222",
          ok: true,
        },
        {
          draftId: "33333333-3333-4333-8333-333333333333",
          ok: false,
          error: "Save failed.",
        },
      ],
    });
    renderModal({ initialInstruction: "Teach both names.", onSaved });
    fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
    expect(await screen.findByDisplayValue("Jon Smythe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Teach Chronote" }));

    await waitFor(() =>
      expect(screen.queryByDisplayValue("Jon Smythe")).not.toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue("Apollo")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
