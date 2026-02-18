import type { Config } from "@docusaurus/types";

const siteUrl = process.env.DOCS_SITE_URL ?? "https://docs.chronote.gg";
const algoliaAppId = process.env.DOCS_ALGOLIA_APP_ID ?? "";
const algoliaApiKey = process.env.DOCS_ALGOLIA_API_KEY ?? "";
const algoliaIndexName = process.env.DOCS_ALGOLIA_INDEX_NAME ?? "";

const hasAlgoliaConfig =
  algoliaAppId !== "" && algoliaApiKey !== "" && algoliaIndexName !== "";
const forceLocalSearch = process.env.DOCS_SEARCH_PROVIDER === "local";
const useLocalSearch = forceLocalSearch || !hasAlgoliaConfig;
const useAlgolia = hasAlgoliaConfig && !forceLocalSearch;

const config: Config = {
  title: "Chronote Docs",
  tagline: "Product documentation for Chronote",
  favicon: "img/chronote-mark.svg",

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
      ]
    : [],

  themeConfig: {
    image: "img/chronote-mark.svg",
    navbar: {
      title: "Chronote Docs",
      logo: {
        alt: "Chronote",
        src: "img/chronote-mark.svg",
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
