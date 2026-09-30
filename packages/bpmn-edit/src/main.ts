// Reads, measures, lays out and edits a BPMN file through the object model of the modeler:
//   metrics  the layout per diagram plane (the process and every collapsed sub-process): overlaps, crossings,
//            flows through shapes, bends, length, extent; the before/after measure of layout work
//   outline  the semantics without DI (lanes, links, the platform's implementation details), one line per element
//            and flow with its XML line; with --around only the neighbourhood of one element, the view an agent
//            needs for a local change
//   layout   tidy (remove overlaps with minimal displacement) or relayout (the SESE fragment around elements anew);
//            a step is only taken when it improves the plane
//   edit     a batch of operations (JSON) with the geometry for everything it touches
//
// Usage: node packages/bpmn-edit/src/main.ts <metrics|outline|layout|edit> <file.bpmn> ... (see USAGE in cli/arguments.ts)
//
// Exit codes: 0 done, 2 usage error, an unreadable file, an unknown element or a failing operation.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Command, parseArguments, USAGE } from "./cli/arguments.ts";
import { formatSummary } from "./cli/output.ts";
import { layout } from "./layout/layout.ts";
import { measure } from "./metrics/metrics.ts";
import { formatTable } from "./metrics/report.ts";
import { applyOperations } from "./operations/apply.ts";
import { parseOperations } from "./operations/parse.ts";
import { outline } from "./outline/outline.ts";
import { formatYaml } from "./outline/yaml.ts";
import { BpmnEditError } from "./utils/errors.ts";

const EXIT_ERROR = 2;
const JSON_INDENT = 2;

/** The file content; a missing file, a directory or a missing permission is an error with the path. */
function readSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new BpmnEditError(`file cannot be read: ${path} (${String(error)})`);
  }
}

function json(value: object): string[] {
  return [JSON.stringify(value, undefined, JSON_INDENT)];
}

async function change(
  command: Extract<Command, { command: "layout" | "edit" }>,
  path: string,
  xml: string,
): Promise<string[]> {
  const outcome =
    command.command === "layout"
      ? await layout(xml, command.request, command.file)
      : await applyOperations(xml, parseOperations(readSource(resolve(command.ops)), command.ops), command.file);
  if (!command.dryRun) {
    writeFileSync(path, outcome.xml);
  }
  const { xml: _xml, ...rest } = outcome;
  const lists: (readonly [string, readonly string[]])[] =
    "result" in outcome
      ? [["moved", outcome.movedIds]]
      : [
          ["changed", outcome.changedIds],
          ["removed", outcome.removedIds],
          ["moved", outcome.movedIds],
        ];
  const diagnostics = "result" in outcome ? outcome.result.diagnostics.map((d) => d.message) : outcome.diagnostics;
  return command.json
    ? json({ written: !command.dryRun, ...rest })
    : formatSummary({
        file: command.file,
        written: !command.dryRun,
        lists,
        diagnostics,
        before: outcome.before,
        after: outcome.after,
      });
}

async function run(command: Command): Promise<string[]> {
  const path = resolve(command.file);
  const xml = readSource(path);
  switch (command.command) {
    case "metrics": {
      const metrics = await measure(xml, command.file);
      return command.json ? json(metrics) : formatTable(metrics);
    }
    case "outline": {
      const result = await outline(xml, command.options, command.file);
      return command.json ? json(result) : formatYaml(result);
    }
    case "layout":
    case "edit":
      return change(command, path, xml);
  }
}

const command = parseArguments(process.argv.slice(2));
if (!command) {
  console.error(USAGE);
  process.exit(EXIT_ERROR);
}

try {
  for (const line of await run(command)) {
    console.log(line);
  }
} catch (error) {
  if (error instanceof BpmnEditError) {
    console.error(`[bpmn-edit] ${error.message}`);
    process.exit(EXIT_ERROR);
  }
  throw error;
}
