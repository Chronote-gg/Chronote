import { describe, expect, jest, test } from "@jest/globals";
import {
  deferInteractionUpdate,
  sendInteractionNotice,
} from "../../src/services/interactionResponseService";

function interactionDouble(state: { deferred: boolean; replied: boolean }) {
  return {
    ...state,
    reply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    followUp: jest.fn().mockResolvedValue(undefined),
  };
}

describe("interactionResponseService", () => {
  test("replies when interaction is not acknowledged", async () => {
    const interaction = interactionDouble({
      deferred: false,
      replied: false,
    });

    const sent = await sendInteractionNotice(
      interaction,
      "Unknown Error handling request.",
    );

    expect(sent).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(
      "Unknown Error handling request.",
    );
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  test("edits the deferred reply so a thinking interaction resolves", async () => {
    const interaction = interactionDouble({ deferred: true, replied: false });

    const sent = await sendInteractionNotice(
      interaction,
      "Unknown Error handling request.",
    );

    expect(sent).toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Unknown Error handling request.",
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test("follows up after a deferred update so the component message survives", async () => {
    const interaction = {
      ...interactionDouble({ deferred: false, replied: false }),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
    };

    await deferInteractionUpdate(interaction);
    interaction.deferred = true;
    const sent = await sendInteractionNotice(interaction, "Notice");

    expect(sent).toBe(true);
    expect(interaction.followUp).toHaveBeenCalledWith("Notice");
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  test("follows up when interaction is already replied", async () => {
    const interaction = interactionDouble({ deferred: false, replied: true });

    const sent = await sendInteractionNotice(
      interaction,
      "Unknown Error handling request.",
    );

    expect(sent).toBe(true);
    expect(interaction.followUp).toHaveBeenCalledWith(
      "Unknown Error handling request.",
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test("reports failure without throwing when the token is unusable", async () => {
    const interaction = interactionDouble({ deferred: true, replied: false });
    interaction.editReply.mockRejectedValue(new Error("Unknown interaction"));
    const logged = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const sent = await sendInteractionNotice(interaction, "Notice");

    expect(sent).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
