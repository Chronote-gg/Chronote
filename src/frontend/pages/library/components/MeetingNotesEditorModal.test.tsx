import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MeetingNotesEditorModal from "./MeetingNotesEditorModal";

test("a dirty notes editor retains its delta when a paused query loses its data", () => {
  const save = jest.fn();
  const editor = (notes: string) => (
    <MantineProvider>
      <MeetingNotesEditorModal
        opened
        initialMarkdown={notes}
        saving={false}
        onClose={() => {}}
        onSave={save}
      />
    </MantineProvider>
  );
  const view = render(editor("Fixture original notes"));
  fireEvent.click(screen.getByTestId("react-quill-mock-change"));
  view.rerender(editor(""));
  fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
  expect(save).toHaveBeenCalledWith({ ops: [{ insert: "Changed\n" }] });
});
