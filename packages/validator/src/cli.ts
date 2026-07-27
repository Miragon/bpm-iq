#!/usr/bin/env node
/**
 * CLI entry for the platform validator. A dedicated entry file (instead of an
 * is-this-the-main-module guard in validate.ts) because Node realpaths the ESM
 * entry while argv[1] keeps a bin shim's symlink path — a guard comparing the
 * two silently no-ops under `npx`/pnpm bin shims.
 *
 * Usage:  node src/cli.ts                     # validate this repo
 *         node src/cli.ts <process>           # one process id (file stem)
 *         node src/cli.ts --root <dir> [<id>] # validate ANOTHER checkout
 *
 * --root makes this the PLATFORM validator: the target checkout is pure data —
 * no code from the target is ever executed.
 *
 * Exit code 0 = no errors (warnings allowed), 1 = errors found.
 */
import { runCli } from "./validate.ts";

await runCli();
