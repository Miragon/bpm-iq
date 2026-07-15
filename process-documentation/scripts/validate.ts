#!/usr/bin/env node
/**
 * Validation entry point for THIS content repository.
 *
 * The actual validator is the bpmiq PLATFORM validator (@bpmiq/validator) —
 * this repo is pure data to it (its layout is the contract, no code from here
 * is ever executed). This shim only locates the validator and runs it with
 * `--root <this repo>`, so every documented invocation keeps working:
 *
 *   node scripts/validate.ts             # whole repo
 *   node scripts/validate.ts <id>        # one process
 *   pnpm validate [<id>]                 # same, via package.json
 *
 * Resolution order:
 *   1. BPMIQ_VALIDATOR   — explicit path to the validator's validate.ts
 *   2. ../packages/validator/src/validate.ts   — inside the bpmiq monorepo
 *   3. node_modules/@bpmiq/validator          — installed dependency (starter)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findValidator(): string | undefined {
  const explicit = process.env.BPMIQ_VALIDATOR;
  if (explicit && existsSync(explicit)) return resolve(explicit);
  // monorepo sibling — but only when its dependencies are actually installed:
  // a bare checkout (e.g. the starter mirrored INSIDE a monorepo checkout in
  // CI) would otherwise crash with MODULE_NOT_FOUND instead of degrading
  const monorepoPkg = resolve(CONTENT_ROOT, "..", "packages", "validator");
  if (existsSync(join(monorepoPkg, "src", "validate.ts")) && existsSync(join(monorepoPkg, "node_modules"))) {
    return join(monorepoPkg, "src", "validate.ts");
  }
  try {
    return createRequire(join(CONTENT_ROOT, "package.json")).resolve("@bpmiq/validator");
  } catch {
    return undefined;
  }
}

const validator = findValidator();
if (!validator) {
  console.error(
    [
      "Cannot find the bpmiq platform validator.",
      "",
      "This content repository is validated by @bpmiq/validator (it treats this",
      "repo as pure data — see docs/governance.md). To run it locally, either:",
      "  - work inside the bpmiq monorepo (packages/validator is picked up automatically),",
      "  - add @bpmiq/validator as a devDependency of this repo, or",
      "  - point BPMIQ_VALIDATOR at a checkout's packages/validator/src/validate.ts.",
      "",
      "Pull requests are always validated by the platform on release.",
    ].join("\n"),
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [validator, "--root", CONTENT_ROOT, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: dirname(validator),
});
process.exit(result.status ?? 1);
