// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
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
