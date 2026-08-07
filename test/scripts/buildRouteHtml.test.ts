import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "build-route-html.mjs");

type RouteConfig = {
  origin: string;
  routes: {
    path: string;
    key: string;
    emitHtml: boolean;
    title?: string;
    description?: string;
  }[];
};

const config: RouteConfig = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts", "public-routes.json"), "utf8"),
);

// The source template rather than a hand written fixture, so dropping a tag
// from the real head fails this test instead of silently shipping a page that
// kept the homepage's canonical URL. Vite only rewrites the script src and
// injects stylesheet links, so the head this cares about is the same either way.
const indexHtml = readFileSync(
  path.join(repoRoot, "src", "frontend", "index.html"),
  "utf8",
);

let buildRoot: string;

const run = (html: string) => {
  mkdirSync(path.join(buildRoot, "frontend"), { recursive: true });
  writeFileSync(path.join(buildRoot, "frontend", "index.html"), html, "utf8");
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ROUTE_HTML_BUILD_ROOT: buildRoot },
    encoding: "utf8",
  });
};

const readRoute = (key: string) =>
  readFileSync(path.join(buildRoot, "frontend-routes", `${key}.html`), "utf8");

describe("build-route-html", () => {
  beforeEach(() => {
    buildRoot = mkdtempSync(path.join(tmpdir(), "route-html-"));
  });

  afterEach(() => {
    rmSync(buildRoot, { recursive: true, force: true });
  });

  it("points each route at itself rather than at the homepage", () => {
    expect(run(indexHtml).status).toBe(0);

    for (const route of config.routes.filter((entry) => entry.emitHtml)) {
      const html = readRoute(route.key);
      const url = `${config.origin}${route.path}`;
      expect(html).toContain(`<link rel="canonical" href="${url}" />`);
      expect(html).toContain(`content="${url}"`);
      expect(html).not.toContain(`href="${config.origin}/"`);
      expect(html).toContain(`<title>${route.title}</title>`);
      expect(html).toContain(route.description);
    }
  });

  it("keeps the bundle entry point intact so the route still boots", () => {
    run(indexHtml);

    expect(readRoute("join")).toContain('<div id="root">');
    expect(readRoute("join")).toContain("/index.tsx");
  });

  it("advertises exactly the configured routes in the sitemap", () => {
    run(indexHtml);
    const sitemap = readFileSync(
      path.join(buildRoot, "frontend", "sitemap.xml"),
      "utf8",
    );

    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => match[1],
    );
    expect(locs).toEqual(
      config.routes.map((route) => `${config.origin}${route.path}`),
    );
  });

  // Silently leaving the homepage's canonical URL in place is the bug this
  // script exists to prevent, so a head it cannot rewrite has to fail the build.
  it("fails the build when a tag it needs is missing", () => {
    const result = run(indexHtml.replace(/<link rel="canonical"[^>]*>/, ""));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("canonical");
  });
});
