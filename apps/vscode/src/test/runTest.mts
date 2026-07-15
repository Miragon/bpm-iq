/**
 * Launches a real VS Code (downloaded on first run), installs the Miragon BPMN
 * Modeler into the test instance, and runs src/test/e2e.ts inside it.
 * Prereq: the Live Host is running (apps/live-host: pnpm start).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionsDir = mkdtempSync(join(tmpdir(), "bpm-live-ext-"));
const userDataDir = mkdtempSync(join(tmpdir(), "bpm-live-usr-"));

const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
if (!cli) throw new Error("could not resolve the VS Code CLI path");

// BPM_MODELER_VSIX=<path> installs a locally built modeler instead of the marketplace build.
const modeler = process.env.BPM_MODELER_VSIX ?? "miragon-gmbh.vs-code-bpmn-modeler";
console.log(`installing Miragon BPMN Modeler into the test instance: ${modeler}`);
const install = spawnSync(
  cli,
  [...cliArgs, "--extensions-dir", extensionsDir, "--install-extension", modeler, "--force"],
  { encoding: "utf8" },
);
console.log(install.stdout?.trim(), install.stderr?.trim() ?? "");

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: ROOT,
  extensionTestsPath: join(ROOT, "out", "test-e2e.js"),
  extensionTestsEnv: {
    // e2e.ts reads the file the Live Host serves in place — default to the
    // monorepo's example content repo, overridable for any other checkout
    LIVE_HOST_CONTENT_DIR: process.env.LIVE_HOST_CONTENT_DIR ?? resolve(ROOT, "..", "..", "process-documentation"),
  },
  launchArgs: [
    "--extensions-dir",
    extensionsDir,
    "--user-data-dir",
    userDataDir,
    "--disable-workspace-trust",
    "--skip-welcome",
  ],
});
console.log("VS Code E2E finished OK");
