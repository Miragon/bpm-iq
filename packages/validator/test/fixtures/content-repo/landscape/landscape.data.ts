// Build-time data loader: feeds the landscape models into the portal viewers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const DIR = dirname(fileURLToPath(import.meta.url));

export interface LandscapeData {
  valueChain: string;
  wardley: string;
  teamTopology: string;
  glossary: { term: string; definition: string; synonyms?: string[]; owner?: string; systems?: string[] }[];
}

declare const data: LandscapeData;
export { data };

export default {
  watch: [
    join(DIR, "value-chain.vc.json"),
    join(DIR, "wardley-map.owm"),
    join(DIR, "team-topology.tt"),
    join(DIR, "glossary.yaml"),
  ],
  load(): LandscapeData {
    const read = (f: string) => readFileSync(join(DIR, f), "utf8");
    return {
      valueChain: read("value-chain.vc.json"),
      wardley: read("wardley-map.owm"),
      teamTopology: read("team-topology.tt"),
      glossary: parseYaml(read("glossary.yaml"))?.terms ?? [],
    };
  },
};
