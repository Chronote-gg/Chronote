import React from "react";
import { expect, test } from "@jest/globals";
import { screen } from "@testing-library/react";
import BasicIntroTerms from "../../src/frontend/components/BasicIntroTerms";
import { monthlyIntroOffer } from "../../src/frontend/pages/basicIntroFixtures";
import { renderWithMantine } from "./testUtils";

test("enrollment deadline states its exact local time and zone", () => {
  const date = new Date("2026-11-02T17:15:30.000Z");
  renderWithMantine(
    <BasicIntroTerms
      offer={{ ...monthlyIntroOffer, enrollmentEndsAt: date.toISOString() }}
    />,
  );
  const expected = date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  expect(screen.getByTestId("basic-intro-terms")).toHaveTextContent(
    "Enroll by " + expected,
  );
});
