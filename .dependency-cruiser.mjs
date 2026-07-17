/**
 * Architecture rules (ArchUnit-style) for the bpmiq workspace — run `pnpm arch`.
 *
 * Public-repo rule set (ADR 0004): identical to the pre-split config minus the
 * control-plane-specific rules — that app lives in the private overlay repo,
 * which carries its own .dependency-cruiser.mjs.
 *
 * Two rule generations live here:
 *  - TODAY rules: scoped to the current file layout, with explicit TODO(arch-N)
 *    grandfathers. The PR that moves a module DELETES its grandfather line.
 *  - HEXAGONAL rules (domain/ports/application/adapters/http): keyed to the
 *    target folders — inert until a folder exists, then enforced automatically.
 *
 * Docs: https://github.com/sverweij/dependency-cruiser
 */

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    /* ── A. cross-package topology ─────────────────────────────────────── */
    {
      name: "no-app-to-app",
      severity: "error",
      comment: "Apps are independently deployable; shared code lives in packages/*.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: ["^apps/$1/"] },
    },
    {
      name: "no-package-to-app",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },

    /* ── B. I/O discipline (today's layout; grandfathers shrink to zero) ── */
    {
      name: "child-process-only-in-designated-adapters",
      severity: "error",
      comment: "Shelling out (git) is an adapter concern.",
      from: {
        path: "^(apps|packages)/",
        pathNot: [
          "(^|/)test/",
          "\\.test\\.ts$",
          // live-host: every subprocess (git) goes through adapters/git/run.ts —
          // workspaces + release use runGit, nothing else shells out.
          "^apps/live-host/src/adapters/git/run\\.ts$",
        ],
      },
      to: { dependencyTypes: ["core"], path: "^(node:)?child_process$" },
    },
    {
      name: "sqlite-only-in-stores",
      severity: "error",
      from: {
        path: "^(apps|packages)/",
        pathNot: [
          "(^|/)test/",
          "\\.test\\.ts$",
          "^apps/live-host/src/(repos/registry|repos/token-minter)\\.ts$",
          "^apps/live-host/src/adapters/sqlite/",
          // TODO(arch-2) GRANDFATHERED: the composition root opens DatabaseSync directly.
          // live-host's lineage store is extracted (adapters/sqlite/lineage-store.ts),
          // but server.ts still OPENS the db and prepares the /healthz deep-liveness
          // write (health table) — move that behind a store, then DELETE this line.
          "^apps/live-host/src/server\\.ts$",
        ],
      },
      // type-only DatabaseSync imports are fine anywhere (erased at runtime) —
      // the rule guards who OPENS/uses the database, not who names its type
      to: { dependencyTypes: ["core"], dependencyTypesNot: ["type-only"], path: "^(node:)?sqlite$" },
    },
    {
      name: "pure-modules-stay-pure",
      severity: "error",
      comment:
        "Unit-testable pure logic: no RUNTIME dependency on I/O builtins. `import type` " +
        "is fine (erased; verbatimModuleSyntax makes it explicit). Transitional list; " +
        "replaced by domain-is-pure once the hexagonal folders land.",
      from: {
        path: ["^apps/live-host/src/domain/"],
      },
      to: {
        dependencyTypesNot: ["type-only"],
        path: "^(node:)?(child_process|fs|fs/promises|http|https|http2|net|tls|dns|sqlite|worker_threads)$",
      },
    },

    /* ── C. frontend rules ─────────────────────────────────────────────── */
    {
      name: "spa-not-to-backend-src",
      severity: "error",
      comment: "SPAs talk to backends over HTTP/WS, never by importing server code.",
      from: { path: "^apps/web/" },
      to: { path: "^apps/(live-host|vscode)/src/" },
    },

    /* ── D. hexagonal layer rules (inert until the folders exist) ──────── */
    {
      name: "domain-is-pure",
      severity: "error",
      comment: "domain/ = pure business logic: no I/O builtins, no npm, no outer layers.",
      from: { path: "^apps/([^/]+)/src/domain/" },
      to: {
        dependencyTypesNot: ["type-only"],
        path: [
          "^apps/$1/src/(application|adapters|http)/",
          "^apps/$1/src/server\\.ts$",
          "^(node:)?(child_process|fs|fs/promises|http|https|http2|net|tls|dns|sqlite|worker_threads)$",
          "node_modules/",
        ],
      },
    },
    {
      name: "application-no-adapter-impls",
      severity: "error",
      comment: "application/ orchestrates domain + ports; adapter IMPLEMENTATIONS only as types.",
      from: { path: "^apps/([^/]+)/src/application/" },
      to: { path: "^apps/$1/src/(adapters|http)/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "adapters-not-to-http-or-application",
      severity: "error",
      comment: "A driven adapter implements a port; it never reaches into the app's inside.",
      from: { path: "^apps/([^/]+)/src/adapters/" },
      to: { path: "^apps/$1/src/(http|application)/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "adapters-no-cross-vendor",
      severity: "error",
      comment: "adapters/<vendor> stay swappable — no imports between vendor folders.",
      from: { path: "^apps/([^/]+)/src/adapters/([^/]+)/" },
      to: {
        path: "^apps/$1/src/adapters/",
        pathNot: ["^apps/$1/src/adapters/$2/"],
        dependencyTypesNot: ["type-only"], // naming another adapter's TYPE is fine
      },
    },
    {
      name: "ports-are-contracts",
      severity: "error",
      comment: "ports/ holds interfaces (+ inert helpers/fakes): no I/O, no outer layers.",
      from: { path: "^apps/([^/]+)/src/ports/" },
      to: {
        dependencyTypesNot: ["type-only"],
        path: [
          "^apps/$1/src/(adapters|http|application)/",
          "^(node:)?(child_process|fs|fs/promises|http|https|net|tls|dns|sqlite)$",
        ],
      },
    },

    /* ── E. hygiene ────────────────────────────────────────────────────── */
    {
      name: "no-undeclared-deps",
      severity: "warn",
      comment: "Import only what your own package.json declares (shamefully-hoist hides this).",
      from: { path: "^(apps|packages)/" },
      to: {
        dependencyTypes: ["npm-no-pkg", "npm-unknown"],
        pathNot: ["^vscode$", "^@/"],
      },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment: "An import that doesn't resolve is broken code or a missing dependency.",
      from: { path: "^(apps|packages)/", pathNot: ["(^|/)test/", "\\.test\\.ts$"] },
      to: { couldNotResolve: true, pathNot: ["^vscode$", "^@/"] },
    },
    {
      name: "no-circular",
      severity: "warn",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "no-orphans",
      severity: "info",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "(^|/)test/",
          "\\.test\\.ts$",
          // SPA files import each other via the "@/" tsconfig alias, which this
          // base-tsconfig cruise can't resolve — orphan detection is blind there
          "^apps/web/src/",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      // NB: scope the dist-exclusion to workspace paths — a bare "(^|/)dist/" also
      // matches node_modules/**/dist/ and silently turns npm imports "unknown".
      path: ["\\.(css|svg|json)$", "^(apps|packages)/.*?/dist/", "^apps/vscode/(out|\\.vscode-test)/"],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
      mainFields: ["module", "main", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs"],
    },
    moduleSystems: ["es6", "cjs"],
    cache: true,
  },
};
