import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

type CloudFrontRequest = { uri: string };

// Evaluated from the same file Terraform uploads, so this cannot drift from
// what is actually deployed. CloudFront Functions declare a global `handler`
// rather than exporting one, hence the vm rather than an import.
const source = fs.readFileSync(
  path.join(__dirname, "..", "docs-index-rewrite.js"),
  "utf8",
);
const handler = vm.runInNewContext(`${source}\nhandler;`) as (event: {
  request: CloudFrontRequest;
}) => CloudFrontRequest;

const rewrite = (uri: string) => handler({ request: { uri } }).uri;

describe("docs index rewrite", () => {
  it("appends index.html to trailing-slash URLs", () => {
    // Docusaurus sets trailingSlash: true, so every sitemap URL looks like this.
    expect(rewrite("/integrations/remote-mcp/")).toBe(
      "/integrations/remote-mcp/index.html",
    );
    expect(rewrite("/")).toBe("/index.html");
  });

  it("appends /index.html to extensionless URLs", () => {
    expect(rewrite("/integrations/remote-mcp")).toBe(
      "/integrations/remote-mcp/index.html",
    );
  });

  it("leaves real files alone", () => {
    for (const uri of [
      "/sitemap.xml",
      "/robots.txt",
      "/index.html",
      "/img/chronote-mark.png",
      "/assets/css/styles.2015c20e.css",
    ]) {
      expect(rewrite(uri)).toBe(uri);
    }
  });

  it("only treats the last segment as a filename", () => {
    // A dot earlier in the path is a directory name, not an extension.
    expect(rewrite("/v1.2/guide")).toBe("/v1.2/guide/index.html");
  });
});
