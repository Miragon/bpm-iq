/**
 * Todo anchor codec — the platform-owned block that ties a tracker item to a
 * process and (optionally) concrete BPMN elements. Trackers store it verbatim
 * (GitHub/GitLab: inside the issue body, invisible as an HTML comment; Jira:
 * in the description) and the platform parses it back out — the tracker never
 * needs to understand it.
 *
 * Format v1 (line-based on purpose — this module is domain code and may not
 * depend on a YAML library):
 *
 *   <!-- bpmiq:todo v1
 *   process: order-to-cash
 *   file: processes/order-to-cash/order-to-cash.bpmn
 *   version: 1.4.0
 *   element: Task_CheckCredit | Bonität prüfen
 *   -->
 *
 * `element:` repeats per anchored element; the part after `|` is the name
 * SNAPSHOT at creation time (elements get renamed — the id stays the anchor,
 * the name keeps the item readable when the id no longer resolves).
 * Parsing is tolerant: unknown lines are skipped, a missing block yields null.
 */

export interface TodoElement {
  id: string;
  /** display-name snapshot at creation time */
  name: string | null;
}

export interface TodoAnchor {
  /** process id (processes/<id>/) */
  process: string;
  /** repo-relative model file the elements live in */
  file: string | null;
  elements: TodoElement[];
  /** process.yaml version at creation time */
  processVersion: string | null;
}

const OPEN = "<!-- bpmiq:todo v1";
const CLOSE = "-->";

/** newlines/pipe would break the line format — flatten them out of names */
const cleanName = (name: string | null): string => (name ?? "").replace(/[\r\n|]+/g, " ").trim();

export function encodeAnchor(anchor: TodoAnchor): string {
  const lines = [OPEN, `process: ${anchor.process}`];
  if (anchor.file) lines.push(`file: ${anchor.file}`);
  if (anchor.processVersion) lines.push(`version: ${anchor.processVersion}`);
  for (const el of anchor.elements) lines.push(`element: ${el.id} | ${cleanName(el.name)}`);
  lines.push(CLOSE);
  return lines.join("\n");
}

export function parseAnchor(text: string): TodoAnchor | null {
  const start = text.indexOf(OPEN);
  if (start === -1) return null;
  const end = text.indexOf(CLOSE, start);
  if (end === -1) return null;
  const anchor: TodoAnchor = { process: "", file: null, elements: [], processVersion: null };
  for (const raw of text.slice(start + OPEN.length, end).split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(": ");
    if (sep === -1) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2).trim();
    if (key === "process") anchor.process = value;
    else if (key === "file") anchor.file = value;
    else if (key === "version") anchor.processVersion = value;
    else if (key === "element") {
      const pipe = value.indexOf(" | ");
      if (pipe === -1) anchor.elements.push({ id: value.replace(/ \|$/, "").trim(), name: null });
      else anchor.elements.push({ id: value.slice(0, pipe).trim(), name: value.slice(pipe + 3).trim() || null });
    }
  }
  return anchor.process ? anchor : null;
}
