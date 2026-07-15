// Dynamic-route loader for the portal: one page per process, straight from the repo.
// Model file contents travel as route params so the viewers need no static-asset copying.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const PROCESSES = dirname(fileURLToPath(import.meta.url));

export default {
  paths() {
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

    const topo = JSON.parse(read(join(PROCESSES, "../landscape/team-topology.tt")) || "{}");
    const teams = Object.fromEntries(
      (topo.nodes ?? []).map((n: { id: string; label: string; type: string }) => [n.id, { label: n.label, type: n.type }]),
    );

    return readdirSync(PROCESSES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(PROCESSES, e.name, "process.yaml")))
      .map((e) => {
        const dir = join(PROCESSES, e.name);
        const meta = parseYaml(read(join(dir, "process.yaml")));
        return {
          params: {
            id: e.name,
            name: meta?.name ?? e.name,
            meta,
            teams,
            bpmnXml: read(join(dir, meta?.models?.bpmn ?? "")),
            subprocesses: (meta?.subprocesses ?? []).map((sp: { id: string; name: string; file: string }) => ({
              id: sp.id,
              name: sp.name,
              xml: read(join(dir, sp.file)),
            })),
            decisions: (meta?.decisions ?? []).map((d: { id: string; name: string; file: string }) => ({
              id: d.id,
              name: d.name,
              xml: read(join(dir, d.file)),
            })),
          },
        };
      });
  },
};
