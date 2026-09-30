/**
 * Parsing and serialization of a BPMN document through bpmn-moddle, the object model and serializer of the modeler
 * (ADR 0008). The platform is detected from the file; a Camunda 7 or Camunda 8 descriptor is loaded only for a file of
 * that platform, so its implementation details are typed. Whatever no loaded descriptor knows (bpmiq stickies, vendor
 * extensions, the unprefixed `calledDecision`) passes through untouched. A document saved by the modeler serializes
 * back byte for byte; XML comments and hand formatting are not preserved.
 */
import { BpmnModdle, type ModdleElement } from "bpmn-moddle";
import camunda from "camunda-bpmn-moddle/resources/camunda.json" with { type: "json" };
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };

import { detectPlatform, type PlatformId } from "../platform/detect.ts";
import { BpmnEditError } from "../utils/errors.ts";

export interface BpmnDocument {
  readonly moddle: BpmnModdle;
  readonly definitions: ModdleElement;
  readonly platform: PlatformId;
  /** the root start tag as read: its namespace declarations survive a write even when nothing uses them */
  readonly rootTag: string;
}

const ROOT_TAG = /<(?:[\w.-]+:)?definitions\b[^>]*>/;
const ATTRIBUTE = /\s([\w.:-]+)\s*=\s*("[^"]*"|'[^']*')/g;

function attributes(tag: string): [string, string][] {
  return [...tag.matchAll(ATTRIBUTE)].map((match) => [match[1] ?? "", match[0]]);
}

/**
 * The written root tag with every namespace declaration of the read one that the serializer left out (moddle drops a
 * declaration a loaded descriptor knows but nothing uses), each after the attribute it followed before.
 */
function keepDeclarations(read: string, written: string): string {
  const present = new Set(attributes(written).map(([name]) => name));
  let tag = written;
  let previous: string | undefined;
  for (const [name, text] of attributes(read)) {
    if (name.startsWith("xmlns") && !present.has(name)) {
      const after = previous === undefined ? undefined : attributes(tag).find(([other]) => other === previous);
      const at = after ? tag.indexOf(after[1]) + after[1].length : tag.search(/\s/);
      tag = tag.slice(0, at) + text + tag.slice(at);
      present.add(name);
    }
    if (present.has(name)) {
      previous = name;
    }
  }
  return tag;
}

const DESCRIPTORS: Readonly<Record<PlatformId, Record<string, object>>> = {
  design: {},
  c7: { camunda },
  c8: { zeebe },
};

export async function parseDocument(xml: string, source: string): Promise<BpmnDocument> {
  const platform = detectPlatform(xml);
  const moddle = new BpmnModdle(DESCRIPTORS[platform]);
  try {
    const { rootElement } = await moddle.fromXML(xml);
    return { moddle, definitions: rootElement, platform, rootTag: ROOT_TAG.exec(xml)?.[0] ?? "" };
  } catch (error) {
    throw new BpmnEditError(`${source}: not a readable BPMN document (${String(error)})`);
  }
}

/** The document in the canonical style of the modeler (two-space indentation, one element per line). */
export async function serializeDocument(document: BpmnDocument): Promise<string> {
  const { xml } = await document.moddle.toXML(document.definitions, { format: true });
  const written = ROOT_TAG.exec(xml)?.[0];
  return written && document.rootTag ? xml.replace(written, keepDeclarations(document.rootTag, written)) : xml;
}

/** Parses and serializes again without a change: the base every later edit builds on. */
export async function roundtrip(xml: string, source: string): Promise<string> {
  return serializeDocument(await parseDocument(xml, source));
}
