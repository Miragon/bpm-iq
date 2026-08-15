#!/usr/bin/env node
/**
 * Guard for the ADR-0003 Docker checklist ("images must COPY new packages").
 *
 * A missing COPY does not fail `docker build` — the pnpm symlink ships and
 * dangles, so the image boots into ERR_MODULE_NOT_FOUND (three prior hits:
 * live-client twice — 84ecac8, a4c6564 — and decisions, #87). This check is
 * static because only booting the container would catch it dynamically, and
 * booting needs runtime config CI does not have.
 *
 * For every image below: walk the app's workspace dependencies transitively
 * (dependencies + devDependencies — raw-.ts images import devDep workspace
 * packages at runtime too) and require each package to have BOTH
 *   - a build-stage `COPY <pkg>/package.json` (so pnpm install links it), and
 *   - a runtime-stage `COPY --from=build /app/<pkg>` (so the symlink resolves).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** image → the workspace package whose runtime deps the image must carry */
const IMAGES = [
  { dockerfile: "apps/live-host/Dockerfile", entry: "apps/live-host" },
  { dockerfile: "Dockerfile", entry: "packages/mcp" },
];

const workspaceDirOf = (name) => name.replace(/^@bpmiq\//, "packages/");

function workspaceDeps(dir) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, version]) => String(version).startsWith("workspace:"))
    .map(([name]) => name);
}

function transitiveClosure(entry) {
  const seen = new Set();
  const queue = workspaceDeps(entry);
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...workspaceDeps(workspaceDirOf(name)));
  }
  return [...seen].map(workspaceDirOf);
}

let failed = false;
for (const { dockerfile, entry } of IMAGES) {
  const content = readFileSync(join(ROOT, dockerfile), "utf8");
  for (const pkg of transitiveClosure(entry)) {
    const missing = [];
    if (!content.includes(`COPY ${pkg}/package.json`)) missing.push(`build-stage \`COPY ${pkg}/package.json\``);
    if (!content.includes(`COPY --from=build /app/${pkg}`))
      missing.push(`runtime-stage \`COPY --from=build /app/${pkg}\``);
    if (missing.length > 0) {
      failed = true;
      console.error(`[ERROR] ${dockerfile}: ${entry} needs ${pkg}, but the image misses its ${missing.join(" and ")}`);
    }
  }
}
if (failed) {
  console.error("A dangling workspace symlink does not fail `docker build` — the image dies at boot (see #87).");
  process.exit(1);
}
console.log("docker workspace coverage: ok");
