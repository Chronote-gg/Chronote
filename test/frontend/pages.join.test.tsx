import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { screen } from "@testing-library/react";
import Join from "../../src/frontend/pages/Join";
import { authState, renderWithMantine, resetFrontendMocks } from "./testUtils";

describe("Join page", () => {
  beforeEach(resetFrontendMocks);

  test("opens the portal home for authenticated users", () => {
    authState.state = "authenticated";

    renderWithMantine(<Join />);

    expect(screen.getByText("Open portal").closest("a")).toHaveAttribute(
      "to",
      "/portal",
    );
  });
});
