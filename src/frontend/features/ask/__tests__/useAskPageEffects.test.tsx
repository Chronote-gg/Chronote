import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { useAskPageEffects } from "../useAskPageEffects";

const noop = () => undefined;
function Harness({
  ready = true,
  shared = false,
}: {
  ready?: boolean;
  shared?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  useAskPageEffects({
    focusReady: ready,
    selectedGuildId: "guild",
    askAccessAllowed: true,
    listMode: shared ? "shared" : "mine",
    sharingEnabled: true,
    activeId: null,
    activeConversation: null,
    activeConversations: [],
    archivedConversations: [],
    sharedConversations: [],
    listIds: [],
    listBusy: false,
    conversationBusy: false,
    isCreatingNew: false,
    newConversationRequested: false,
    askPending: false,
    highlightedMessageId: null,
    displayMessagesLength: 0,
    chatViewportRef,
    inputRef,
    navigateToConversation: noop,
    setOptimisticMessages: noop,
    setOptimisticConversation: noop,
    setIsCreatingNew: noop,
    setNewConversationRequested: noop,
    setRenameDraft: noop,
    setRenaming: noop,
    setRenameError: noop,
    setArchiveError: noop,
    optimisticMessages: [],
    activeMessages: [],
  });
  return (
    <>
      <button>Another control</button>
      <textarea aria-label="Question" ref={inputRef} />
    </>
  );
}
describe("Ask initial focus", () => {
  beforeEach(() => {
    jest
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(noop);
  });
  afterEach(() => jest.restoreAllMocks());
  test("focuses the ready blank desktop composer", () => {
    render(<Harness />);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });
  test("does not open a mobile keyboard", () => {
    jest
      .mocked(window.matchMedia)
      .mockReturnValue({ matches: false } as MediaQueryList);
    render(<Harness />);
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });
  test("accepts the navigation link that had focus when Ask mounted", () => {
    const link = document.createElement("a");
    link.href = "/ask";
    document.body.append(link);
    link.focus();
    const { rerender } = render(<Harness ready={false} />);
    rerender(<Harness ready />);
    expect(screen.getByRole("textbox")).toHaveFocus();
    link.remove();
  });
  test("does not steal focus from a control used while loading", () => {
    const { rerender } = render(<Harness ready={false} />);
    screen.getByRole("button").focus();
    rerender(<Harness ready />);
    expect(screen.getByRole("button")).toHaveFocus();
  });
  test("does not focus a read-only shared chat", () => {
    render(<Harness shared />);
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });
});
