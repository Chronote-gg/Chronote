import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  // Node.js scripts and CommonJS child-process fixtures
  {
    files: [
      "scripts/**/*.{js,mjs,cjs}",
      "_infra/production-bootstrap/**/*.cjs",
      "_infra/sandbox-bootstrap/**/*.cjs",
      "test/deployment/**/*.cjs",
      "test/audio/fixtures/voiceCaptureExit.cjs",
      "test/observability/fixtures/langfuseOpenaiCacheUsage.cjs",
    ],
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
