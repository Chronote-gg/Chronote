import { describe, expect, test } from "@jest/globals";
import { resolveRedirectTarget } from "../../src/services/oauthRedirectService";

describe("oauthRedirectService", () => {
  test("allows relative redirects", () => {
    expect(
      resolveRedirectTarget(
        "/portal/select-server?promo=SAVE20",
        "https://app.example.com",
      ),
    ).toBe("https://app.example.com/portal/select-server?promo=SAVE20");
  });

  test("allows explicitly approved internal redirects", () => {
    expect(
      resolveRedirectTarget(
        "/api/notion/connect?redirect=https%3A%2F%2Fapp.example.com%2Fportal",
        "https://app.example.com",
        { allowedInternalPaths: ["/api/notion/connect"] },
      ),
    ).toBe(
      "/api/notion/connect?redirect=https%3A%2F%2Fapp.example.com%2Fportal",
    );
  });

  test("keeps unapproved internal redirects on the frontend origin", () => {
    expect(
      resolveRedirectTarget("/api/other", "https://app.example.com", {
        allowedInternalPaths: ["/api/notion/connect"],
      }),
    ).toBe("https://app.example.com/api/other");
  });

  test("blocks protocol-relative redirects", () => {
    expect(
      resolveRedirectTarget("//evil.com/portal", "https://app.example.com"),
    ).toBeUndefined();
  });

  test("allows redirects to approved origins", () => {
    const target =
      "https://app.example.com/portal/server/g1/library?meetingId=meeting-1";
    expect(resolveRedirectTarget(target, "https://app.example.com")).toBe(
      target,
    );
  });

  test("rejects redirects to unknown origins", () => {
    expect(
      resolveRedirectTarget(
        "https://evil.example.com/portal",
        "https://app.example.com",
      ),
    ).toBeUndefined();
  });

  test("rejects dangerous schemes", () => {
    expect(
      resolveRedirectTarget("javascript:alert(1)", "https://app.example.com"),
    ).toBeUndefined();
    expect(
      resolveRedirectTarget(
        "data:text/html;base64,PHNjcmlwdD4=",
        "https://app.example.com",
      ),
    ).toBeUndefined();
  });

  test("preserves hash fragments for same-origin urls", () => {
    const target = "https://app.example.com/portal/server/g1/library#section-1";
    expect(resolveRedirectTarget(target, "https://app.example.com")).toBe(
      target,
    );
  });
});
