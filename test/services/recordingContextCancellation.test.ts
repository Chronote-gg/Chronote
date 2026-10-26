/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { fetchChannelContext } from "../../src/services/channelContextService";
import { resolveConfigSnapshot } from "../../src/services/unifiedConfigService";
import {
  listRecentMeetingsForChannelService,
  listRecentMeetingsForGuildService,
} from "../../src/services/meetingHistoryService";

jest.mock("../../src/services/configService", () => {
  const actual = jest.requireActual("../../src/services/configService");
  return {
    ...actual,
    config: {
      ...actual.config,
      mock: { ...actual.config.mock, enabled: false },
      database: { ...actual.config.database, useLocalDynamoDB: true },
    },
  };
});

const reads: Array<[string, (signal: AbortSignal) => Promise<unknown>]> = [
  [
    "server config scope",
    (signal) =>
      resolveConfigSnapshot(
        { guildId: "generated-guild" },
        { signal, strict: true },
      ),
  ],
  [
    "channel context scope",
    (signal) =>
      fetchChannelContext("generated-guild", "generated-channel", signal),
  ],
  [
    "channel memory history",
    (signal) =>
      listRecentMeetingsForChannelService(
        "generated-guild",
        "generated-channel",
        2,
        signal,
      ),
  ],
  [
    "guild summary history",
    (signal) =>
      listRecentMeetingsForGuildService("generated-guild", 2, { signal }),
  ],
];
test.each(reads)(
  "%s cancellation settles its actual SDK request",
  async (_name, read) => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settled = false;
    let watchdogFired = false;
    const controller = new AbortController();
    const handler = jest
      .spyOn(NodeHttpHandler.prototype, "handle")
      .mockImplementation(async (_request, options) => {
        expect(options?.abortSignal).toBe(controller.signal);
        try {
          return await new Promise<never>((_resolve, reject) => {
            const signal = options!.abortSignal!;
            const abort = () => {
              clearTimeout(watchdog);
              signal.onabort = null;
              reject(
                Object.assign(new Error("generated abort"), {
                  name: "AbortError",
                }),
              );
            };
            const watchdog = setTimeout(() => {
              watchdogFired = true;
              abort();
            }, 1000);
            signal.onabort = abort;
            entered();
          });
        } finally {
          settled = true;
        }
      });
    try {
      const task = read(controller.signal);
      const rejected = expect(task).rejects.toThrow("generated abort");
      await ready;
      controller.abort();
      await rejected;
      expect(settled).toBe(true);
      expect(watchdogFired).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      handler.mockRestore();
    }
  },
);
