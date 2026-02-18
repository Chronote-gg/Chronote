import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "index",
    "getting-started/overview",
    {
      type: "category",
      label: "Core Concepts",
      items: ["core-concepts/meeting-lifecycle"],
    },
    {
      type: "category",
      label: "Features",
      items: ["features/feature-overview"],
    },
    {
      type: "category",
      label: "Integrations",
      items: ["integrations/overview"],
    },
    {
      type: "category",
      label: "Admin and Setup",
      items: ["admin/setup-and-access"],
    },
    {
      type: "category",
      label: "Troubleshooting",
      items: ["troubleshooting/common-issues"],
    },
    {
      type: "category",
      label: "Maintaining Docs",
      items: ["maintaining-docs/style-guide"],
    },
    "whats-new/index",
  ],
};

export default sidebars;
