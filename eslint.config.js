// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "crates/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // The CLI distribution shell is plain CommonJS (no "type" in its
    // package.json, no build step), so its Node globals must be declared.
    files: ["packages/cli/bin/**/*.js"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
    rules: {
      // CommonJS is the point of the shell: no build step may sit between
      // the published bin script and Node.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Engine purity: the refino package must not depend on any Node API
    // (docs/design.md, "引擎纯净性").
    files: ["packages/refino/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message: "The refino engine must stay free of Node APIs.",
            },
          ],
        },
      ],
    },
  },
);
