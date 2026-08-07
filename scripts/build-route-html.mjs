import fs from "node:fs";
import path from "node:path";

/**
 * Gives each public route its own head metadata.
 *
 * The app is one bundle, so every route is served the same index.html and would
 * otherwise inherit the homepage's canonical URL and Open Graph tags. Search
 * engines consolidate such routes into the homepage rather than indexing them,
 * and link previews show homepage copy, which matters most on Discord where
 * these links get shared.
 *
 * Each route's HTML is derived from the built index.html, so script tags,
 * styles and everything else stay in lockstep with whatever Vite produced. Only
 * the head differs; the body is still the empty SPA root that boots and routes
 * as normal. Deploy uploads these to extensionless S3 keys so /join resolves to
 * one instead of falling through CloudFront's SPA fallback to index.html.
 *
 * The sitemap is generated from the same file, so the routes advertised to
 * crawlers cannot drift from the routes that actually carry correct metadata.
 */

const repoRoot = process.cwd();
const buildRoot = path.resolve(
  process.env.ROUTE_HTML_BUILD_ROOT || path.join(repoRoot, "build"),
);
const buildDir = path.join(buildRoot, "frontend");
const routesOutDir = path.join(buildRoot, "frontend-routes");

const config = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "scripts", "public-routes.json"), "utf8"),
);

const escapeHtml = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Rewrites one tag's value, matched on its identifying attribute rather than on
 * position so reordering the head cannot silently break this. A missing tag
 * throws: emitting a page that quietly kept the homepage's canonical URL is the
 * exact bug this script exists to prevent, so it has to fail the build instead.
 */
const setTagValue = (html, matcher, attribute, value) => {
  const pattern = new RegExp(
    `(<(?:meta|link)\\s+[^>]*${matcher}[^>]*?\\b${attribute}=")[^"]*(")`,
    "i",
  );
  if (!pattern.test(html)) {
    throw new Error(`Could not find <${matcher}> to set ${attribute}.`);
  }
  return html.replace(pattern, `$1${escapeHtml(value)}$2`);
};

const buildRouteHtml = (indexHtml, route) => {
  const url = `${config.origin}${route.path}`;
  const edits = [
    ['rel="canonical"', "href", url],
    ['property="og:url"', "content", url],
    ['property="og:title"', "content", route.title],
    ['name="twitter:title"', "content", route.title],
    ['name="description"', "content", route.description],
    ['property="og:description"', "content", route.description],
    ['name="twitter:description"', "content", route.description],
  ];
  const html = edits.reduce(
    (current, [matcher, attribute, value]) =>
      setTagValue(current, matcher, attribute, value),
    indexHtml,
  );
  return html.replace(
    /<title>[^<]*<\/title>/i,
    `<title>${escapeHtml(route.title)}</title>`,
  );
};

const buildSitemap = () =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...config.routes.map((route) =>
      [
        "  <url>",
        `    <loc>${config.origin}${route.path}</loc>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority}</priority>`,
        "  </url>",
      ].join("\n"),
    ),
    "</urlset>",
    "",
  ].join("\n");

const indexHtml = fs.readFileSync(path.join(buildDir, "index.html"), "utf8");

fs.rmSync(routesOutDir, { recursive: true, force: true });
fs.mkdirSync(routesOutDir, { recursive: true });

for (const route of config.routes.filter((entry) => entry.emitHtml)) {
  const dest = path.join(routesOutDir, `${route.key}.html`);
  fs.writeFileSync(dest, buildRouteHtml(indexHtml, route), "utf8");
  console.log(`route html: ${route.path} -> ${path.relative(repoRoot, dest)}`);
}

const sitemapPath = path.join(buildDir, "sitemap.xml");
fs.writeFileSync(sitemapPath, buildSitemap(), "utf8");
console.log(`sitemap: ${config.routes.length} urls`);
