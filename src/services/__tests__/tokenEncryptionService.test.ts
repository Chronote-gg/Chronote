import { jest } from "@jest/globals";

jest.mock("../configService", () => ({
  config: {
    notion: { tokenEncryptionSecret: "notion-token-encryption-secret" },
  },
}));

import { decryptToken, encryptToken } from "../tokenEncryptionService";

describe("tokenEncryptionService", () => {
  it("encrypts tokens using a reversible authenticated format", () => {
    const encrypted = encryptToken("notion-access-token");

    expect(encrypted).not.toContain("notion-access-token");
    expect(decryptToken(encrypted)).toBe("notion-access-token");
  });
});
