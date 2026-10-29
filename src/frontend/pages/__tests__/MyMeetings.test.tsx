import { render, screen } from "@testing-library/react";
import MyMeetings from "../MyMeetings";
jest.mock("../UnifiedMeetingsPage", () => ({
  __esModule: true,
  default: () => <div>Unified Meetings</div>,
}));
test("the Meetings entry uses the unified page", () => {
  render(<MyMeetings />);
  expect(screen.getByText("Unified Meetings")).toBeInTheDocument();
});
