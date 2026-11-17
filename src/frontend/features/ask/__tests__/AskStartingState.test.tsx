import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { AskStartingState } from "../AskStartingState";

const meeting = {
  id: "1",
  title: "Team planning",
  timestamp: "2026-11-16T14:00:00Z",
};
const props = {
  count: 4,
  notesCount: 2,
  meetings: [meeting],
  loading: false,
  failed: false,
  selectedIds: [],
  onSelect: jest.fn(),
  onExample: jest.fn(),
  onRetry: jest.fn(),
};
const show = (overrides = {}) =>
  render(
    <MantineProvider>
      <AskStartingState {...props} {...overrides} />
    </MantineProvider>,
  );
describe("Ask starting state", () => {
  test("distinguishes scope from note-bearing records and adds context without navigation", () => {
    show();
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 accessible meetings in this view (2 with notes)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to context" }));
    expect(props.onSelect).toHaveBeenCalledWith(meeting);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  test("examples fill a question and selected cards cannot duplicate context", () => {
    show({ selectedIds: ["1"] });
    expect(screen.getByRole("button", { name: "Added" })).toBeDisabled();
    const example = "What decisions were made in our meetings?";
    fireEvent.click(screen.getByRole("button", { name: "Decisions" }));
    expect(props.onExample).toHaveBeenCalledWith(example);
  });
  test("searches the library and reports partial coverage without claiming completeness", () => {
    const onSearchChange = jest.fn();
    show({ searchQuery: "planning", onSearchChange, coverage: "partial" });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Find meeting context" }),
      { target: { value: "October" } },
    );
    expect(onSearchChange).toHaveBeenCalledWith("October");
    expect(screen.getByRole("note")).toHaveTextContent(
      "Some accessible meetings may be missing",
    );
  });
  test.each([
    [{ count: undefined, loading: true }, "Checking meeting history..."],
    [
      { count: undefined, failed: true },
      "Meeting history could not be loaded.",
    ],
    [{ count: 0, meetings: [] }, "No matching meetings are available to Ask."],
    [{ count: undefined }, "Meeting coverage is not yet confirmed."],
  ])("keeps loading, failure, zero and unknown distinct", (overrides, text) => {
    show(overrides);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.getByRole("status")).not.toHaveTextContent("undefined");
  });
});
