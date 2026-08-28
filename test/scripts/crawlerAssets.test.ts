import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

describe("crawler assets", () => {
  it("publishes a concise llms.txt containing only public canonical sources", () => {
    const llms = fs.readFileSync(
      path.join(repoRoot, "public", "llms.txt"),
      "utf8",
    );

    expect(llms).toMatch(/^# Chronote\n/);
    expect(llms).toContain("https://chronote.gg/");
    expect(llms).toContain("https://docs.chronote.gg/getting-started/");
    expect(llms).toContain("https://docs.chronote.gg/legal/privacy/");
    expect(llms).not.toMatch(
      /https:\/\/chronote\.gg\/(?:portal|admin|live|share)/,
    );
    expect(llms.length).toBeLessThan(5000);
  });

  it("keeps llms.txt on the short-lived stable-file deployment path", () => {
    const action = fs.readFileSync(
      path.join(repoRoot, ".github", "actions", "sync-frontend", "action.yml"),
      "utf8",
    );

    expect(action).toContain(
      "for stable in manifest.json sitemap.xml robots.txt llms.txt 404.html; do",
    );
  });

  it("ships a noindex document for CloudFront's S3 error remap", () => {
    const notFound = fs.readFileSync(
      path.join(repoRoot, "public", "404.html"),
      "utf8",
    );

    expect(notFound).toContain(
      '<meta name="robots" content="noindex, nofollow"',
    );
    expect(notFound).not.toContain("window.__API_BASE_URL__");
  });

  it("publishes valid software application structured data", () => {
    const html = fs.readFileSync(
      path.join(repoRoot, "src", "frontend", "index.html"),
      "utf8",
    );
    const match = html.match(
      /<script id="chronote-structured-data" type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
    );

    expect(match).not.toBeNull();
    const structuredData = JSON.parse(match![1]) as {
      "@graph": Array<Record<string, unknown>>;
    };
    const application = structuredData["@graph"].find(
      (entry) =>
        Array.isArray(entry["@type"]) &&
        entry["@type"].includes("SoftwareApplication"),
    );

    expect(application).toMatchObject({
      name: "Chronote",
      url: "https://chronote.gg/",
      applicationCategory: "CommunicationApplication",
      offers: { price: "0", priceCurrency: "USD" },
    });
  });
});
