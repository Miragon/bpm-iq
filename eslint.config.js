// Flat ESLint config for the bpmiq monorepo (one root config, no per-package configs).
// Pragmatic first adoption: the genuinely bug-catching type-aware rules
// (no-floating-promises, no-misused-promises) are ERRORS; stylistic strictness
// (no-explicit-any) is a WARN ratchet. Prettier owns formatting (config last).
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // never lint generated / vendored / data-contract trees, config files, or the
    // content repo (its own tsconfig arrives in a later phase)
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.live/**", // host-owned runtime state (cloned tenant workspaces)
      "**/.control/**", // control-plane runtime state
      "apps/vscode/out/**",
      "apps/vscode/.vscode-test/**",
      "process-documentation/**",
      "packages/validator/test/fixtures/**",
      "**/*.vue",
      "**/*.config.{js,ts,mjs,mts}",
      "eslint.config.js",
      ".dependency-cruiser.mjs",
      "scripts/oss-split/overlay/**", // export templates — linted in the public repo (ADR 0004)
      ".oss-export/**", // export staging tree
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      // the two type-aware rules worth the projectService cost — real async bugs
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      // checksVoidReturn off: async event handlers / setInterval callbacks are a
      // deliberate, pervasive pattern here — the genuinely-useful part (a promise
      // used as a condition) stays on
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      // destructure-to-omit (`const { jti, ...rest } = x`) + _-prefixed intentional unused
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // auto-fixable hygiene
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      // ratchet toward error later
      "@typescript-eslint/no-explicit-any": "warn",
      // stylistic core rule — noisy on intentional rethrows; revisit as a ratchet
      "preserve-caught-error": "off",
    },
  },
  // Node servers/tools/packages: node globals; server logging is legitimate
  {
    files: ["apps/control-plane/**/*.ts", "apps/live-host/**/*.ts", "apps/vscode/**/*.ts", "packages/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  // React clients (web + the control-plane operator SPA + the shared UI kit): browser globals + hooks
  {
    files: ["apps/web/**/*.{ts,tsx}", "apps/control-plane/ui/**/*.{ts,tsx}", "packages/ui-kit/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // just the two stable rules — skip the experimental compiler-adjacent set
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Tests + stubs need loose typing (mocks, stub payloads)
  {
    files: ["**/test/**/*.ts", "**/*.test.ts", "apps/live-host/src/guest-test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // node:test `test(...)` returns a promise that is intentionally not awaited
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  // ── architecture complement (see .dependency-cruiser.mjs) — rules a dependency
  //    graph can't see, because they're globals/properties, not imports.
  // 1) env access belongs in the composition roots (server.ts) — WARN ratchet:
  //    verified scattered across ~10 files today; flip to error as the hexagonal
  //    refactor moves config reading into server.ts.
  {
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts", "packages/mcp/*.ts"],
    ignores: [
      "apps/*/src/server.ts", // composition roots
      "apps/live-host/src/tools/**", // CLIs are their own roots
      "apps/live-host/src/guest-test.ts", // standalone spike client
      "packages/mcp/server.ts",
      "packages/mcp/http.ts", // MCP transport bootstrap (own root)
    ],
    rules: {
      "no-restricted-properties": [
        "warn",
        {
          object: "process",
          property: "env",
          message: "Read env in the composition root (server.ts) and pass config down.",
        },
      ],
    },
  },
  // 2) pure modules must not do network I/O (fetch is a global, invisible to
  //    dependency-cruiser). Clean today → error from day one.
  {
    files: [
      "apps/control-plane/src/{reconcile,cookies,stripe,rate-limit,entitlements}.ts",
      "apps/live-host/src/{doc-size-guard,conn-limit,crypt}.ts",
      "apps/live-host/src/repos/rooms.ts",
      "apps/*/src/domain/**/*.ts", // the hexagonal target folders, once they exist
      "apps/*/src/ports/**/*.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Pure module — inject the HTTP call through a port instead." },
      ],
    },
  },
  prettier,
);
