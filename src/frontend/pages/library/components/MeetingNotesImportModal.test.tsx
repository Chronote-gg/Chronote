import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MeetingNotesImportModal from "./MeetingNotesImportModal";

const renderModal = (props?: { saving?: boolean; onImport?: jest.Mock }) => {
  const onImport = props?.onImport ?? jest.fn();
  render(
    <MantineProvider>
      <MeetingNotesImportModal
        opened
        saving={props?.saving ?? false}
        onClose={jest.fn()}
        onImport={onImport}
      />
    </MantineProvider>,
  );
  return { onImport };
};

describe("MeetingNotesImportModal", () => {
  it("submits pasted notes with source metadata", () => {
    const { onImport } = renderModal();

    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "# External notes" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Source name" }), {
      target: { value: "Notion" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Source URL" }), {
      target: { value: "https://example.com/notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import notes" }));

    expect(onImport).toHaveBeenCalledWith({
      notes: "# External notes",
      mode: "append",
      sourceName: "Notion",
      sourceUrl: "https://example.com/notes",
    });
  });

  it("disables import until notes are provided", () => {
    renderModal();

    expect(screen.getByRole("button", { name: "Import notes" })).toBeDisabled();
  });
});
