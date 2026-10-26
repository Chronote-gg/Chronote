import { expect, test } from "@jest/globals";
import {
  buildFinalAcceptanceTransaction,
  buildFinalJournalWrite,
} from "../../src/services/productionAcceptanceTransactions";
import { finalFixture } from "../fixtures/productionFinalAcceptance";
test.each(["admission", "epoch", "authority", "clock"])(
  "refuses invalid final %s authority before producing a request",
  (change) => {
    const input = finalFixture("reopen_admission");
    if (change === "admission")
      input.hold.admission = { state: "reopened", receiptId: "other" };
    if (change === "epoch") input.control.servingGeneration++;
    if (change === "authority") input.authority.actor = "other";
    if (change === "clock") input.now = input.authority.validUntil;
    expect(() => buildFinalAcceptanceTransaction(input)).toThrow();
  },
);
test("final journal cannot turn an observed or unknown action into a new dispatch", () => {
  const input = finalFixture(),
    previous = input.action;
  expect(() =>
    buildFinalJournalWrite({
      table: input.table,
      hold: input.hold,
      authority: input.authority,
      previous,
      next: previous,
      now: 320,
    }),
  ).toThrow();
});
