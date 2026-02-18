import { describe, expect, jest, test } from "@jest/globals";
import { tryReplyToUnacknowledgedInteraction } from "../../src/services/interactionResponseService";

describe("interactionResponseService", () => {
  test("replies when interaction is not acknowledged", async () => {
    const reply = jest.fn().mockResolvedValue(undefined);

    const sent = await tryReplyToUnacknowledgedInteraction(
      {
        deferred: false,
        replied: false,
        reply,
      },
      "Unknown Error handling request.",
    );

    expect(sent).toBe(true);
    expect(reply).toHaveBeenCalledWith("Unknown Error handling request.");
  });

  test("does not reply when interaction is already deferred", async () => {
    const reply = jest.fn().mockResolvedValue(undefined);

    const sent = await tryReplyToUnacknowledgedInteraction(
      {
        deferred: true,
        replied: false,
        reply,
      },
      "Unknown Error handling request.",
    );

    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  test("does not reply when interaction is already replied", async () => {
    const reply = jest.fn().mockResolvedValue(undefined);

    const sent = await tryReplyToUnacknowledgedInteraction(
      {
        deferred: false,
        replied: true,
        reply,
      },
      "Unknown Error handling request.",
    );

    expect(sent).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});
