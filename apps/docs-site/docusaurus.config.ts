import type { Config } from "@docusaurus/types";
import { writeFile } from "node:fs/promises";
import path from "node:path";

type PostBuildArgs = { outDir: string; siteConfig: { url: string } };

const siteUrl = process.env.DOCS_SITE_URL?.trim() || "https://docs.chronote.gg";
const algoliaAppId = process.env.DOCS_ALGOLIA_APP_ID ?? "";
const algoliaApiKey = process.env.DOCS_ALGOLIA_API_KEY ?? "";
const algoliaIndexName = process.env.DOCS_ALGOLIA_INDEX_NAME ?? "";

const hasAlgoliaConfig =
  algoliaAppId !== "" && algoliaApiKey !== "" && algoliaIndexName !== "";
const forceLocalSearch = process.env.DOCS_SEARCH_PROVIDER === "local";
const useLocalSearch = forceLocalSearch || !hasAlgoliaConfig;
const useAlgolia = hasAlgoliaConfig && !forceLocalSearch;

const robotsTxtPlugin = () => ({
  name: "chronote-robots-txt",
  // Written at build time rather than kept in static/, so sandbox and staging
  // advertise their own sitemap instead of the production one. Docusaurus
  // copies static/ verbatim and would hardcode whichever host was committed.
  async postBuild({ outDir, siteConfig }: PostBuildArgs) {
    const body = [
      "# https://www.robotstxt.org/robotstxt.html",
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${new URL("sitemap.xml", siteConfig.url).toString()}`,
      "",
    ].join("\n");
    await writeFile(path.join(outDir, "robots.txt"), body, "utf8");
  },
});

const config: Config = {
  title: "Chronote Docs",
  tagline: "Product documentation for Chronote",
  favicon: "img/favicon.ico",

  url: siteUrl,
  baseUrl: "/",
  trailingSlash: true,

  organizationName: "Chronote-gg",
  projectName: "Chronote",

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          path: "docs",
          sidebarPath: "./sidebars.ts",
          editUrl:
            "https://github.com/Chronote-gg/Chronote/tree/master/apps/docs-site/",
        },
        blog: false,
        pages: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      },
    ],
  ],

  plugins: useLocalSearch
    ? [
        [
          "@easyops-cn/docusaurus-search-local",
          {
            indexDocs: true,
            indexBlog: false,
            docsRouteBasePath: "/",
            language: ["en"],
            hashed: true,
          },
        ],
        robotsTxtPlugin,
      ]
    : [robotsTxtPlugin],

  themeConfig: {
    image: "img/chronote-social-card.png",
    navbar: {
      title: "Chronote Docs",
      logo: {
        alt: "Chronote",
        src: "img/chronote-mark.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          to: "/whats-new/",
          label: "What's New",
          position: "left",
        },
        {
          href: "https://chronote.gg",
          label: "Chronote",
          position: "right",
        },
        {
          href: "https://github.com/Chronote-gg/Chronote",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Product",
          items: [
            {
              label: "Getting Started",
              to: "/getting-started/",
            },
            {
              label: "Integrations",
              to: "/integrations/",
            },
          ],
        },
        {
          title: "Support",
          items: [
            {
              label: "Troubleshooting",
              to: "/troubleshooting/common-issues/",
            },
            {
              label: "GitHub Issues",
              href: "https://github.com/Chronote-gg/Chronote/issues",
            },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} Chronote`,
    },
    ...(useAlgolia
      ? {
          algolia: {
            appId: algoliaAppId,
            apiKey: algoliaApiKey,
            indexName: algoliaIndexName,
          },
        }
      : {}),
  },
};

export default config;
