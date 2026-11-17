import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAskPageEffects } from "../useAskPageEffects";

const noop = () => undefined;
function Harness({
  ready = true,
  shared = false,
  viewport,
  streamContentLength = 0,
  messageCount = 0,
  pending = false,
}: {
  ready?: boolean;
  shared?: boolean;
  viewport?: HTMLDivElement;
  streamContentLength?: number;
  messageCount?: number;
  pending?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(viewport ?? null);
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
    askPending: pending,
    highlightedMessageId: null,
    displayMessagesLength: messageCount,
    streamContentLength,
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

  test("growing streamed text follows the bottom at a fixed message count and respects scrolling up", () => {
    const viewport = document.createElement("div");
    let height = 300;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 100 },
      scrollTop: { value: 0, writable: true },
    });
    const scrollTo = jest.fn(({ top }: ScrollToOptions) => {
      viewport.scrollTop = Number(top) - viewport.clientHeight;
      fireEvent.scroll(viewport);
    });
    Object.defineProperty(viewport, "scrollTo", { value: scrollTo });
    const { rerender } = render(
      <Harness
        ready={false}
        viewport={viewport}
        streamContentLength={5}
        messageCount={2}
        pending
      />,
    );
    scrollTo.mockClear();
    height = 450;
    rerender(
      <Harness
        ready={false}
        viewport={viewport}
        streamContentLength={15}
        messageCount={2}
        pending
      />,
    );
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 450, behavior: "smooth" });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    scrollTo.mockClear();
    height = 600;
    rerender(
      <Harness
        ready={false}
        viewport={viewport}
        streamContentLength={25}
        messageCount={2}
        pending
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(100);
    viewport.scrollTop = height - viewport.clientHeight;
    fireEvent.scroll(viewport);
    height = 700;
    rerender(
      <Harness
        ready={false}
        viewport={viewport}
        streamContentLength={35}
        messageCount={2}
        pending
      />,
    );
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: "smooth" });
  });
});
