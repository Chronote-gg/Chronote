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

const crawlerFilesPlugin = () => ({
  name: "chronote-crawler-files",
  // Written at build time rather than kept in static/, so sandbox and staging
  // advertise their own sitemap instead of the production one. Docusaurus
  // copies static/ verbatim and would hardcode whichever host was committed.
  async postBuild({ outDir, siteConfig }: PostBuildArgs) {
    const body = [
      "# https://www.robotstxt.org/robotstxt.html",
      "User-agent: *",
      "Allow: /",
      "",
      "# Public docs are intentionally available to ordinary search engines,",
      "# OAI-SearchBot, GPTBot, and user-triggered assistants.",
      "",
      `Sitemap: ${new URL("sitemap.xml", siteConfig.url).toString()}`,
      "",
    ].join("\n");
    await writeFile(path.join(outDir, "robots.txt"), body, "utf8");

    const docsUrl = (pathname: string) =>
      new URL(pathname, `${siteConfig.url}/`).toString();
    const llms = [
      "# Chronote Documentation",
      "",
      "> Public documentation for Chronote, a Discord bot that records voice meetings, transcribes each speaker, posts structured notes, and answers sourced questions about past meetings.",
      "",
      "Use these canonical public pages for current product behavior and setup. Portal pages, shared meetings, and meeting contents are not public documentation.",
      "",
      "## Start here",
      "",
      `- [Chronote](${docsUrl("/")}): Documentation home and product overview.`,
      `- [Discord meeting notes guide](${docsUrl("/discord-meeting-notes/")}): What the bot does and how the workflow fits a Discord server.`,
      `- [Getting started](${docsUrl("/getting-started/")}): Installation, permissions, onboarding, and the first meeting.`,
      `- [Features](${docsUrl("/features/")}): Commands and product capabilities.`,
      "",
      "## Product documentation",
      "",
      `- [Meeting lifecycle](${docsUrl("/core-concepts/meeting-lifecycle/")}): Recording, processing, publishing, and revision stages.`,
      `- [Integrations](${docsUrl("/integrations/")}): Web portal, Notion, Discord, and Remote MCP integrations.`,
      `- [Troubleshooting](${docsUrl("/troubleshooting/common-issues/")}): Common setup and recording problems.`,
      `- [What's New](${docsUrl("/whats-new/")}): Recent public product changes.`,
      "",
      "## Trust and policies",
      "",
      `- [Privacy Policy](${docsUrl("/legal/privacy/")}): What Chronote records, stores, and sends to service providers.`,
      `- [Terms of Service](${docsUrl("/legal/terms/")}): Terms governing use of Chronote.`,
      "",
    ].join("\n");
    await writeFile(path.join(outDir, "llms.txt"), llms, "utf8");
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
        sitemap: {
          ignorePatterns: ["/search/", "/search/**"],
          changefreq: null,
          priority: null,
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
        crawlerFilesPlugin,
      ]
    : [crawlerFilesPlugin],

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
