/** Command line of the entry point: a command, one BPMN file, flags. */
import type { LayoutRequest } from "../layout/layout.ts";
import type { OutlineOptions } from "../outline/types.ts";

export type Command =
  | { readonly command: "metrics"; readonly file: string; readonly json: boolean }
  | { readonly command: "outline"; readonly file: string; readonly json: boolean; readonly options: OutlineOptions }
  | {
      readonly command: "layout";
      readonly file: string;
      readonly json: boolean;
      readonly dryRun: boolean;
      readonly request: LayoutRequest;
    }
  | {
      readonly command: "edit";
      readonly file: string;
      readonly json: boolean;
      readonly dryRun: boolean;
      readonly ops: string;
    };

export const USAGE = [
  "Usage: node packages/bpmn-edit/src/main.ts metrics <file.bpmn> [--json]",
  "       node packages/bpmn-edit/src/main.ts outline <file.bpmn> [--around <id>] [--depth <n>] [--bounds] [--full] [--json]",
  "       node packages/bpmn-edit/src/main.ts layout  <file.bpmn> --mode tidy|relayout|layout [--scope <id>[,<id>...] | --plane <id>] [--dry-run] [--json]",
  "       node packages/bpmn-edit/src/main.ts edit    <file.bpmn> --ops <operations.json> [--dry-run] [--json]",
].join("\n");

/** Flow steps around `--around` when `--depth` is not given. */
export const DEFAULT_DEPTH = 2;

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--around", "--depth", "--mode", "--scope", "--plane", "--ops"]);
const ALLOWED: Readonly<Record<Command["command"], ReadonlySet<string>>> = {
  metrics: new Set(["--json"]),
  outline: new Set(["--json", "--bounds", "--full", "--around", "--depth"]),
  layout: new Set(["--json", "--dry-run", "--mode", "--scope", "--plane"]),
  edit: new Set(["--json", "--dry-run", "--ops"]),
};
const NON_NEGATIVE_INTEGER = /^\d+$/;

interface Tokens {
  readonly files: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

/** Splits the arguments into files, flags and flag values; undefined when a value flag has no value. */
function tokenize(args: readonly string[]): Tokens | undefined {
  const files: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      files.push(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        return undefined;
      }
      values.set(arg, value);
    } else {
      flags.add(arg);
    }
  }
  return { files, flags, values };
}

function isCommand(name: string | undefined): name is Command["command"] {
  return name !== undefined && Object.hasOwn(ALLOWED, name);
}

function outlineOptions(tokens: Tokens): OutlineOptions | undefined {
  const depth = tokens.values.get("--depth");
  if (depth !== undefined && !NON_NEGATIVE_INTEGER.test(depth)) {
    return undefined;
  }
  return {
    around: tokens.values.get("--around"),
    depth: depth === undefined ? DEFAULT_DEPTH : Number(depth),
    bounds: tokens.flags.has("--bounds"),
    full: tokens.flags.has("--full"),
  };
}

function layoutRequest(tokens: Tokens): LayoutRequest | undefined {
  const mode = tokens.values.get("--mode");
  const scope = tokens.values.get("--scope");
  const plane = tokens.values.get("--plane");
  if ((mode !== "tidy" && mode !== "relayout" && mode !== "layout") || (scope !== undefined && plane !== undefined)) {
    return undefined;
  }
  if (scope !== undefined) {
    const ids = scope.split(",").filter((id) => id.length > 0);
    return ids.length > 0 ? { mode, scope: { kind: "fragmentOf", ids } } : undefined;
  }
  return { mode, scope: plane === undefined ? { kind: "all" } : { kind: "plane", id: plane } };
}

function build(command: Command["command"], file: string, tokens: Tokens): Command | undefined {
  const json = tokens.flags.has("--json");
  const dryRun = tokens.flags.has("--dry-run");
  switch (command) {
    case "metrics":
      return { command, file, json };
    case "outline": {
      const options = outlineOptions(tokens);
      return options ? { command, file, json, options } : undefined;
    }
    case "layout": {
      const request = layoutRequest(tokens);
      return request ? { command, file, json, dryRun, request } : undefined;
    }
    case "edit": {
      const ops = tokens.values.get("--ops");
      return ops ? { command, file, json, dryRun, ops } : undefined;
    }
  }
}

/** The command, or undefined when the arguments do not match the usage (unknown flags included). */
export function parseArguments(args: readonly string[]): Command | undefined {
  const [command, ...rest] = args;
  const tokens = tokenize(rest);
  const [file] = tokens?.files ?? [];
  if (!isCommand(command) || !tokens || !file || tokens.files.length !== 1) {
    return undefined;
  }
  const allowed = ALLOWED[command];
  const known = [...tokens.flags, ...tokens.values.keys()].every((flag) => allowed.has(flag));
  return known ? build(command, file, tokens) : undefined;
}
