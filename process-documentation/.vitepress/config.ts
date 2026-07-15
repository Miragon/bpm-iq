import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitepress";
import { parse as parseYaml } from "yaml";

const ROOT = join(__dirname, "..");

/** One sidebar entry per modeled process, straight from the repo. */
function processSidebarItems() {
  const dir = join(ROOT, "processes");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "process.yaml")))
    .map((e) => {
      const meta = parseYaml(readFileSync(join(dir, e.name, "process.yaml"), "utf8"));
      return { text: meta?.name ?? e.name, link: `/processes/${e.name}` };
    })
    .sort((a, b) => a.text.localeCompare(b.text));
}

export default defineConfig({
  title: "BPM Portal",
  description: "Let your processes talk — the process landscape, browsable.",
  srcDir: ".",
  srcExclude: ["**/node_modules/**", "dist/**", "templates/**", ".claude/**", "CLAUDE.md"],
  rewrites: {
    "processes/INDEX.md": "processes/index.md",
  },
  // Repo markdown links to non-page files (process.yaml, .bpmn, LICENSE, …) on purpose.
  ignoreDeadLinks: true,
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Processes", link: "/processes/" },
      { text: "Landscape", link: "/landscape/" },
      { text: "Method", link: "/docs/method" },
      { text: "About", link: "/README" },
    ],
    sidebar: {
      "/processes/": [
        { text: "Process index", link: "/processes/" },
        { text: "Processes", items: processSidebarItems() },
        { text: "Conventions", link: "/processes/README" },
      ],
      "/docs/": [
        {
          text: "Method & Governance",
          items: [
            { text: "The method: four views", link: "/docs/method" },
            { text: "Modeling conventions", link: "/docs/modeling-conventions" },
            { text: "process.yaml schema", link: "/docs/process-metadata" },
            { text: "Governance", link: "/docs/governance" },
            { text: "Migration playbook", link: "/docs/migration" },
            { text: "Automation path", link: "/docs/automation" },
          ],
        },
      ],
      "/landscape/": [
        { text: "Landscape", link: "/landscape/" },
        { text: "Identifier contract", link: "/landscape/README" },
      ],
    },
    outline: [2, 3],
    search: { provider: "local" },
  },
});
