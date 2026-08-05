import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.VITE_MOCK_FIXED_NOW ??= "";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config: StorybookConfig = {
  stories: [
    "../src/frontend/**/*.mdx",
    "../src/frontend/**/*.stories.@(ts|tsx)",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: ["../public"],
  // The default react-docgen parser picks up the root babel.config.js, which
  // exists for Jest and carries preset-typescript with no JSX support. That
  // makes it parse every .tsx as plain TS, so `<Component prop={x}>` reads as
  // an unterminated type assertion and the transform throws. Every .tsx in the
  // project then 404s, which takes the whole preview down. The TypeScript
  // parser does not go through babel, and gives better prop tables anyway.
  typescript: { reactDocgen: "react-docgen-typescript" },
  async viteFinal(config) {
    return mergeConfig(config, {
      envDir: rootDir,
      plugins: [
        tsconfigPaths({
          projects: [resolve(rootDir, "tsconfig.frontend.json")],
        }),
      ],
    });
  },
};

export default config;
