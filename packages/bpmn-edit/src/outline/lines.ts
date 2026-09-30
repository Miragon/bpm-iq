/** Line numbers of the elements in the XML text, so an agent can jump from the outline to the source. */

const OPENING_TAG_WITH_ID = /<[A-Za-z][\w:.-]*\s[^>]*?\bid="([^"]+)"/g;
const DIAGRAM_START = "<bpmndi:BPMNDiagram";

/** The 1-based line of the first opening tag per id, for the semantic part of the document (before the DI). */
export function lineNumbers(xml: string): Map<string, number> {
  const diagramStart = xml.indexOf(DIAGRAM_START);
  const semantic = diagramStart === -1 ? xml : xml.slice(0, diagramStart);
  const lines = new Map<string, number>();
  let line = 1;
  let scanned = 0;
  for (const match of semantic.matchAll(OPENING_TAG_WITH_ID)) {
    const [, id] = match;
    if (!id || lines.has(id)) {
      continue;
    }
    line += countNewlines(semantic, scanned, match.index);
    scanned = match.index;
    lines.set(id, line);
  }
  return lines;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = text.indexOf("\n", from); index !== -1 && index < to; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}
