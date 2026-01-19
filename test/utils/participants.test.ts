import { describe, expect, test } from "@jest/globals";
import type { Participant } from "../../src/types/participants";
import {
  extractDiscordUserId,
  resolveAttendeeDisplayName,
} from "../../src/utils/participants";

describe("extractDiscordUserId", () => {
  test("extracts ids from mentions, urls, and raw ids", () => {
    expect(extractDiscordUserId("<@123>")).toBe("123");
    expect(extractDiscordUserId("<@!456>")).toBe("456");
    expect(extractDiscordUserId("https://discord.com/users/789")).toBe("789");
    expect(
      extractDiscordUserId("https://canary.discord.com/users/101112"),
    ).toBe("101112");
    expect(extractDiscordUserId("123456789012345678")).toBe(
      "123456789012345678",
    );
  });

  test("returns undefined when no id is present", () => {
    expect(extractDiscordUserId("Alice")).toBeUndefined();
    expect(extractDiscordUserId("<@notanid>")).toBeUndefined();
  });
});

describe("resolveAttendeeDisplayName", () => {
  const participants = new Map<string, Participant>([
    [
      "123",
      {
        id: "123",
        username: "alpha",
        displayName: "Alpha",
        serverNickname: "A",
        tag: "alpha#0001",
      },
    ],
    [
      "456",
      {
        id: "456",
        username: "beta",
        tag: "beta#0002",
      },
    ],
  ]);

  test("resolves mentions to display names", () => {
    expect(resolveAttendeeDisplayName("<@123>", participants)).toBe("A");
    expect(resolveAttendeeDisplayName("<@!456>", participants)).toBe("beta");
  });

  test("falls back to the original value when unresolved", () => {
    expect(resolveAttendeeDisplayName("<@999>", participants)).toBe("<@999>");
    expect(resolveAttendeeDisplayName("Guest", participants)).toBe("Guest");
  });
});
