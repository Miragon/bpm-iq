/**
 * The content-repo contract (bpmiq.yml) — the ONE definition of "what is a
 * content repo, and what are its models", shared by every consumer that reads
 * a checkout: the Live Host, the MCP server, and the validator.
 *
 *   # bpmiq.yml
 *   models: processes        # or the legacy alias:  processes: processes
 *
 * A repo is a content repo iff a root bpmiq.yml names the folder its model
 * files live in. A model IS a file with a registered notation extension under
 * that folder (@bpmiq/notations); its id is the file stem (modelStem). A
 * process is the .bpmn special case, a decision the .dmn one. Nothing else
 * about the layout is assumed.
 *
 * Node-only (fs + yaml) — imported via the "@bpmiq/notations/content" subpath,
 * NEVER from the browser-safe package index.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, posix, relative } from "node:path";

import { parse as parseYaml } from "yaml";

import { extractModelGraph } from "./extract.ts";
import { byExtension, modelStem } from "./index.ts";
import { refsOf } from "./refs.ts";

export const CONTENT_CONFIG_FILE = "bpmiq.yml";

export interface ContentConfig {
  /** repo-root-relative folder holding ALL model files ("." = root) */
  models: string;
  /** the same folder under its legacy name — kept so existing consumers keep
   *  compiling; `models` and `processes` are always identical */
  processes: string;
}

/**
 * Read + validate <root>/bpmiq.yml — `models:` names the model folder, the
 * legacy `processes:` key stays a full alias (existing repos remain valid
 * unchanged). `undefined` means "not a content repo" — an unreadable/
 * unparseable/ill-typed config must degrade to that, never crash a listing
 * (the file is plausibly mid-edit in a live session).
 */
export function loadContentConfig(root: string): ContentConfig | undefined {
  const file = join(root, CONTENT_CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const raw = parsed as { models?: unknown; processes?: unknown } | null;
  const folder = raw?.models ?? raw?.processes;
  if (typeof folder !== "string" || folder.trim().length === 0) return undefined;
  // normalize so discovery and the room-containment gate agree on one spelling
  // ("a//b", "p/.", "./p" collapse); "." / "" mean "models live at the root"
  const normalized = posix.normalize(folder.trim()).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return { models: ".", processes: "." };
  // the folder must stay inside the repo — no absolute paths, no traversal
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  return { models: normalized, processes: normalized };
}

export interface DiscoveredProcess {
  /** file name without .bpmn — unique per repo (release/todo routes key on it) */
  id: string;
  /** repo-root-relative path of the .bpmn file */
  path: string;
}

/** a discovered .dmn decision — same id rule as processes (file stem) */
export interface DiscoveredDecision {
  /** file name without .dmn — unique per repo */
  id: string;
  /** repo-root-relative path of the .dmn file */
  path: string;
}

/** a discovered model file of ANY registered notation */
export interface DiscoveredModel {
  /** file stem (modelStem) — unique per repo and notation (routes key on it) */
  id: string;
  /** repo-root-relative path of the model file */
  path: string;
  /** registry notation id (byExtension, longest suffix wins) */
  notation: string;
}

/**
 * Every file with a registered notation extension under the configured folder
 * (recursive, sorted by path). The id is the file stem (modelStem) so it stays
 * a single URL segment; ids are unique PER NOTATION (order.bpmn and order.dmn
 * are legal separate namespaces) — a second same-notation file with the same
 * stem elsewhere in the tree is skipped + logged rather than shadowing the
 * first.
 */
export async function discoverModels(root: string, cfg: ContentConfig): Promise<DiscoveredModel[]> {
  const dir = join(root, cfg.models);
  // missing folder or a config that names a FILE (ENOTDIR) is "no files",
  // never a crash — the config is plausibly mid-edit in a live session
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const paths = entries
    .filter((e) => e.isFile())
    .map((e) => join(cfg.models, relative(dir, join(e.parentPath, e.name))))
    .filter((p) => !p.split("/").some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
  const out: DiscoveredModel[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const notation = byExtension(path);
    if (!notation) continue;
    const id = modelStem(path);
    const key = `${notation.id}/${id}`; // notation ids never contain "/"
    const first = seen.get(key);
    if (first) {
      console.log(`content: duplicate ${notation.id} id '${id}' (${path}) — keeping ${first}`);
      continue;
    }
    seen.set(key, path);
    out.push({ id, path, notation: notation.id });
  }
  return out;
}

/** a Reference with its source attached and its target resolved (or not) */
export interface ResolvedReference {
  from: { path: string; notation: string; element?: string };
  rel: string;
  to: { id: string; notation?: string; element?: string };
  strength: "required" | "informative";
  /** the artifact the reference resolves to; undefined = dangling/external */
  resolved?: DiscoveredModel;
}

/**
 * The repo-wide reference index — built once per checkout, the substrate for
 * who-uses-what, backlink navigation, release impact and link validation.
 */
export interface RepoIndex {
  artifacts: DiscoveredModel[];
  refs: ResolvedReference[];
  byId(id: string, notation?: string): DiscoveredModel | undefined;
  /** references EMITTED by the model at `path` */
  outgoing(path: string): ResolvedReference[];
  /** references POINTING AT the model at `path` (resolved ones only) */
  incoming(path: string): ResolvedReference[];
}

/**
 * Build the reference index of a checkout: discover every model, run its
 * extract + refs capabilities, resolve each reference against the discovered
 * artifacts. Degrades per file (an unreadable/broken model simply emits no
 * refs) — an index build must never fail a listing or a release.
 */
export async function buildRepoIndex(root: string, cfg: ContentConfig): Promise<RepoIndex> {
  const artifacts = await discoverModels(root, cfg);
  const byKey = new Map<string, DiscoveredModel>();
  for (const a of artifacts) byKey.set(`${a.notation}/${a.id}`, a);
  const byId = (id: string, notation?: string): DiscoveredModel | undefined =>
    notation ? byKey.get(`${notation}/${id}`) : artifacts.find((a) => a.id === id);

  const refs: ResolvedReference[] = [];
  for (const artifact of artifacts) {
    let emitted;
    try {
      const raw = readFileSync(join(root, artifact.path), "utf8");
      const graph = extractModelGraph(artifact.path, raw);
      emitted = graph ? refsOf(graph) : [];
    } catch {
      continue;
    }
    for (const ref of emitted) {
      refs.push({
        from: {
          path: artifact.path,
          notation: artifact.notation,
          ...(ref.fromElement ? { element: ref.fromElement } : {}),
        },
        rel: ref.rel,
        to: ref.to,
        strength: ref.strength,
        resolved: byId(ref.to.id, ref.to.notation),
      });
    }
  }

  return {
    artifacts,
    refs,
    byId,
    outgoing: (path) => refs.filter((r) => r.from.path === path),
    incoming: (path) => refs.filter((r) => r.resolved?.path === path),
  };
}

/** every .bpmn under the configured folder — a process IS its BPMN file */
export async function discoverProcesses(root: string, cfg: ContentConfig): Promise<DiscoveredProcess[]> {
  return (await discoverModels(root, cfg)).filter((m) => m.notation === "bpmn").map(({ id, path }) => ({ id, path }));
}

/** every .dmn under the configured folder — a decision IS its DMN file */
export async function discoverDecisions(root: string, cfg: ContentConfig): Promise<DiscoveredDecision[]> {
  return (await discoverModels(root, cfg)).filter((m) => m.notation === "dmn").map(({ id, path }) => ({ id, path }));
}
