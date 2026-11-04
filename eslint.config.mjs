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
  // A deferred update targets the original component message, so the notice helper
  // has to know the deferral happened or its notice overwrites that shared message.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/services/interactionResponseService.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression > MemberExpression[property.name='deferUpdate']",
          message:
            "Use deferInteractionUpdate from services/interactionResponseService: sendInteractionNotice must know an interaction was deferred as an update, or its notice replaces the shared component message instead of reaching the user.",
        },
      ],
    },
  },
];
