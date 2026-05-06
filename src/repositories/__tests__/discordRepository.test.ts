import { assertDiscordSnowflake, DiscordApiError } from "../discordRepository";

describe("discordRepository", () => {
  it("accepts Discord snowflake ids", () => {
    expect(assertDiscordSnowflake("123456789012345678", "guild id")).toBe(
      "123456789012345678",
    );
  });

  it("rejects non-snowflake ids before Discord API URL construction", () => {
    expect(() => assertDiscordSnowflake("../members/1", "guild id")).toThrow(
      DiscordApiError,
    );
  });
});
