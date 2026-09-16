/* eslint-disable @typescript-eslint/no-require-imports */
import { TextDecoder, TextEncoder } from "util";
import {
  ReadableStream as WebReadableStream,
  TransformStream as WebTransformStream,
  WritableStream as WebWritableStream,
} from "node:stream/web";

// Ensure encoders/streams/fetch globals for discord.js expectations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = global as any;
g.TextEncoder = g.TextEncoder || TextEncoder;
g.TextDecoder = g.TextDecoder || TextDecoder;
g.ReadableStream = g.ReadableStream || WebReadableStream;
g.WritableStream = g.WritableStream || WebWritableStream;
g.TransformStream = g.TransformStream || WebTransformStream;

// Load undici after polyfilling encoders so its internals see them.
const {
  Headers,
  Request,
  Response,
  ReadableStream,
  TransformStream,
  WritableStream,
  fetch,
} = require("undici");

g.ReadableStream = g.ReadableStream || ReadableStream;
g.WritableStream = g.WritableStream || WritableStream;
g.TransformStream = g.TransformStream || TransformStream;
g.fetch = g.fetch || fetch;
g.Headers = g.Headers || Headers;
g.Request = g.Request || Request;
g.Response = g.Response || Response;

const {
  buildMeetingNotesEmbeds,
  formatNotesEmbedTitle,
  resolveNotesEmbedBaseTitle,
}: typeof import("../../src/utils/meetingNotes") = require("../../src/utils/meetingNotes");

describe("meetingNotes utils", () => {
  test("resolveNotesEmbedBaseTitle trims and falls back", () => {
    expect(resolveNotesEmbedBaseTitle()).toBe("Meeting Notes");
    expect(resolveNotesEmbedBaseTitle("  Sprint planning ")).toBe(
      "Sprint planning",
    );
  });

  test("formatNotesEmbedTitle adds part suffix when needed", () => {
    expect(formatNotesEmbedTitle("Notes", 0, 1)).toBe("Notes");
    expect(formatNotesEmbedTitle("Notes", 1, 3)).toBe("Notes (part 2/3)");
  });

  test("buildMeetingNotesEmbeds uses meeting name as title", () => {
    const embeds = buildMeetingNotesEmbeds({
      notesBody: "Hello there",
      meetingName: "Sprint planning",
      footerText: "v1",
    });
    expect(embeds).toHaveLength(1);
    const json = embeds[0].toJSON();
    expect(json.title).toBe("Sprint planning");
    expect(json.footer?.text).toBe("v1");
  });

  test("buildMeetingNotesEmbeds falls back to default title", () => {
    const embeds = buildMeetingNotesEmbeds({
      notesBody: "Hello there",
    });
    expect(embeds).toHaveLength(1);
    const json = embeds[0].toJSON();
    expect(json.title).toBe("Meeting Notes");
  });

  test("keeps partial notes unchanged and adds the warning to every footer", () => {
    const notesBody = "A".repeat(5000);
    const embeds = buildMeetingNotesEmbeds({
      notesBody,
      footerText: "v2",
      processing: { transcription: "partial", notes: "generated" },
    });

    expect(embeds).toHaveLength(2);
    expect(embeds.map((embed) => embed.toJSON().description).join("")).toBe(
      notesBody,
    );
    for (const embed of embeds) {
      expect(embed.toJSON().footer?.text).toBe(
        "v2 • Some audio could not be transcribed. These notes may be incomplete.",
      );
    }
  });

  test("uses processing explanations outside stored note content", () => {
    const embeds = buildMeetingNotesEmbeds({
      notesBody: "",
      processing: { transcription: "empty", notes: "skipped" },
    });

    expect(embeds[0].toJSON().description).toBe(
      "No usable speech was found, so no notes were generated.",
    );
  });
});
