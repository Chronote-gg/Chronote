/** @jest-environment node */
import {
  runNotionMutation,
  registerNotionMutationTracker,
} from "../../src/services/notionOperationLifetime";
test.each([undefined, new AbortController().signal])(
  "unowned Notion mutation refuses before provider dispatch",
  async (signal) => {
    const effect = jest.fn(async () => "created");
    await expect(runNotionMutation(signal, effect)).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
  },
);
test("registered owner can finish its tracked acknowledgment chain", async () => {
  const controller = new AbortController();
  const unregister = registerNotionMutationTracker(controller.signal, (run) =>
    run(),
  );
  const receipt = jest.fn(async () => {});
  try {
    await runNotionMutation(controller.signal, async () => {
      controller.abort();
      await receipt();
    });
    expect(receipt).toHaveBeenCalledTimes(1);
  } finally {
    unregister();
  }
});

test.each([400, 503])(
  "Notion status %s distinguishes known rejection from uncertain response",
  async (status) => {
    const { NotionApiError, UnresolvedNotionMutation } =
      await import("../../src/services/notionOperationLifetime");
    const signal = new AbortController().signal;
    const failedTracker = jest.fn();
    const unregister = registerNotionMutationTracker(signal, async (run) => {
      try {
        return await run();
      } catch (error) {
        failedTracker();
        throw error;
      }
    });
    const error = new NotionApiError(
      status,
      "synthetic",
      "Synthetic rejection",
    );
    try {
      const result = runNotionMutation(signal, async () => {
        throw error;
      });
      if (status === 400) await expect(result).rejects.toBe(error);
      else
        await expect(result).rejects.toBeInstanceOf(UnresolvedNotionMutation);
      expect(failedTracker).toHaveBeenCalledTimes(status === 400 ? 0 : 1);
    } finally {
      unregister();
    }
  },
);
