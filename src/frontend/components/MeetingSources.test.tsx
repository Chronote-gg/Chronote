import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import userEvent from "@testing-library/user-event";
import MeetingSources from "./MeetingSources";

it("selects intrinsic and server sources with visible names and URL-owned state", () => {
  const select = jest.fn();
  render(
    <MantineProvider>
      <MeetingSources
        sources={[
          {
            id: "one",
            name: "A very long server name",
            icon: "bad",
            retainedAccess: true,
          },
        ]}
        scope={{ kind: "personal" }}
        onSelect={select}
      />
    </MantineProvider>,
  );
  expect(
    screen.getByRole("button", { name: "Personal recordings" }),
  ).toHaveAttribute("aria-pressed", "true");
  const server = screen.getByRole("button", {
    name: /A very long server name/,
  });
  expect(server).toHaveAttribute("aria-pressed", "false");
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("AV")).toBeInTheDocument();
  fireEvent.click(server);
  expect(select).toHaveBeenCalledWith({ kind: "guild", serverId: "one" });
  fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
  expect(select).toHaveBeenLastCalledWith({ kind: "all" });
  expect(
    screen.getByRole("region", { name: "Meeting sources" }),
  ).toHaveAttribute("tabindex", "0");
});

it("supports tab and keyboard source selection", async () => {
  const user = userEvent.setup();
  const onSelect = jest.fn();
  render(
    <MantineProvider>
      <MeetingSources
        sources={[{ id: "guild", name: "Guild" }]}
        scope={{ kind: "all" }}
        onSelect={onSelect}
      />
    </MantineProvider>,
  );
  await user.tab();
  expect(screen.getByRole("region", { name: "Meeting sources" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "All meetings" })).toHaveFocus();
  await user.tab();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith({ kind: "personal" });
  await user.tab();
  await user.keyboard(" ");
  expect(onSelect).toHaveBeenLastCalledWith({
    kind: "guild",
    serverId: "guild",
  });
});
