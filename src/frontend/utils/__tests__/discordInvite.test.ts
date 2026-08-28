import { buildInstallUrl } from "../discordInvite";

describe("buildInstallUrl", () => {
  it("routes installs through the API with direct attribution", () => {
    const url = buildInstallUrl({
      ctaLocation: "hero",
      currentUrl: "https://chronote.gg/",
      doNotTrack: false,
    });

    expect(url).toBe(
      "/auth/discord/install?source=direct&medium=web&landing_path=%2F&cta_location=hero",
    );
  });

  it("carries campaign parameters and only the referrer hostname", () => {
    const url = buildInstallUrl({
      ctaLocation: "footer-cta",
      currentUrl:
        "https://chronote.gg/?utm_source=newsletter&utm_medium=email&utm_campaign=launch",
      referrer: "https://www.example.com/private/path?person=someone",
      doNotTrack: false,
    });

    expect(url).toContain("source=newsletter");
    expect(url).toContain("medium=email");
    expect(url).toContain("campaign=launch");
    expect(url).toContain("referrer_domain=example.com");
    expect(url).not.toContain("private");
    expect(url).not.toContain("person");
  });

  it("uses the referrer as the source when no campaign source exists", () => {
    const url = buildInstallUrl({
      ctaLocation: "join",
      currentUrl: "https://chronote.gg/join",
      referrer: "https://chatgpt.com/c/secret-conversation",
      doNotTrack: false,
    });

    expect(url).toContain("source=chatgpt.com");
    expect(url).toContain("medium=referral");
    expect(url).toContain("landing_path=%2Fjoin");
    expect(url).not.toContain("secret-conversation");
  });

  it("does not send attribution when Do Not Track is enabled", () => {
    expect(
      buildInstallUrl({
        ctaLocation: "hero",
        currentUrl: "https://chronote.gg/?utm_source=private-campaign",
        doNotTrack: true,
      }),
    ).toBe("/auth/discord/install?dnt=1");
  });

  it("removes content-like campaign values and private route ids before navigation", () => {
    const url = buildInstallUrl({
      ctaLocation: "site-footer",
      currentUrl:
        "https://chronote.gg/share/meeting/server-secret/share-secret?utm_campaign=person@example.com",
      doNotTrack: false,
    });

    expect(url).toContain("landing_path=other");
    expect(url).not.toContain("server-secret");
    expect(url).not.toContain("share-secret");
    expect(url).not.toContain("person%40example.com");
  });

  it("does not count Chronote navigation as an acquisition source", () => {
    const url = buildInstallUrl({
      ctaLocation: "join",
      currentUrl: "https://chronote.gg/join",
      referrer: "https://api.chronote.gg/auth/discord/callback?code=secret",
      doNotTrack: false,
    });

    expect(url).toContain("source=direct");
    expect(url).not.toContain("api.chronote.gg");
    expect(url).not.toContain("secret");
  });
});
