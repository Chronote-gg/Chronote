import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

type CloudFrontRequest = { uri: string };
type CloudFrontResponse = {
  statusCode: number;
  headers?: Record<string, { value: string }>;
  body?: string;
};

const source = fs.readFileSync(
  path.join(__dirname, "..", "frontend-route-rewrite.js"),
  "utf8",
);
const handler = vm.runInNewContext(`${source}\nhandler;`) as (event: {
  request: CloudFrontRequest;
}) => CloudFrontRequest | CloudFrontResponse;

const publicRouteConfig = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "scripts", "public-routes.json"),
    "utf8",
  ),
) as { routes: { path: string }[] };

const invoke = (uri: string) => handler({ request: { uri } });

describe("frontend route rewrite", () => {
  it("serves the homepage document for the root", () => {
    expect(invoke("/")).toEqual({ uri: "/index.html" });
  });

  it("leaves every extensionless public-route object intact", () => {
    for (const route of publicRouteConfig.routes) {
      if (route.path === "/") continue;
      expect(invoke(route.path)).toEqual({ uri: route.path });
    }
  });

  it("serves public-route trailing slash variants from the canonical object", () => {
    for (const route of publicRouteConfig.routes) {
      if (route.path === "/") continue;
      expect(invoke(`${route.path}/`)).toEqual({ uri: route.path });
    }
  });

  it("rewrites the frontend's dynamic and authenticated routes", () => {
    for (const uri of [
      "/promo/summer",
      "/upgrade/select-server",
      "/upgrade/success",
      "/live/123/meeting-1",
      "/admin",
      "/admin/config",
      "/portal",
      "/portal/server/123/library",
      "/share/ask/123/conversation-1",
      "/share/meeting/123/share-1",
    ]) {
      expect(invoke(uri)).toEqual({ uri: "/index.html" });
    }
  });

  it("preserves common trailing slash variants of known SPA routes", () => {
    for (const uri of [
      "/promo/summer/",
      "/upgrade/select-server/",
      "/upgrade/success/",
      "/live/123/meeting-1/",
      "/share/ask/123/conversation-1/",
      "/share/meeting/123/share-1/",
    ]) {
      expect(invoke(uri)).toEqual({ uri: "/index.html" });
    }
  });

  it("returns a real noindex 404 for unknown extensionless paths", () => {
    for (const uri of [
      "/definitely-not-real",
      "/promo/",
      "/live/123",
      "/share/ask/123",
    ]) {
      expect(invoke(uri)).toMatchObject({
        statusCode: 404,
        headers: { "x-robots-tag": { value: "noindex, nofollow" } },
        body: "Not Found",
      });
    }
  });

  it("lets real file requests reach the origin", () => {
    for (const uri of [
      "/robots.txt",
      "/sitemap.xml",
      "/llms.txt",
      "/og-image.png",
      "/assets/index.abc123.js",
    ]) {
      expect(invoke(uri)).toEqual({ uri });
    }
  });
});
