/**
 * Which platform a BPMN file is written for (ADR 0008): detected from the file, never imposed. The root element
 * decides — `modeler:executionPlatform` when present, otherwise which engine namespace the file actually uses. A file
 * that names no platform, or uses both engine namespaces, is a design model: only the platform-free core applies.
 */

export type PlatformId = "design" | "c7" | "c8";

const CAMUNDA_URI = "http://camunda.org/schema/1.0/bpmn";
const ZEEBE_URI = "http://camunda.org/schema/zeebe/1.0";

const ROOT_TAG = /<(?:[\w.-]+:)?definitions\b[^>]*>/;
const NAMESPACE = /\sxmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g;
const EXECUTION_PLATFORM = /\s[\w.-]+:executionPlatform\s*=\s*["']([^"']*)["']/;

/**
 * Execution platform names the Camunda Modeler writes, by the platform they mean. Forks that keep the `camunda:`
 * namespace are recognised by that namespace; a fork with a namespace of its own (whether Operaton has one is open,
 * ADR 0008) stays a design model until an adapter for it exists.
 */
const PLATFORM_NAMES: Readonly<Record<string, PlatformId>> = {
  "camunda cloud": "c8",
  "camunda platform": "c7",
};

/** The prefix the file binds to the namespace, if any. */
function prefixOf(root: string, uri: string): string | undefined {
  for (const [, prefix, bound] of root.matchAll(NAMESPACE)) {
    if (bound === uri) {
      return prefix;
    }
  }
  return undefined;
}

/** Whether an element or attribute with the prefix occurs outside the root tag's namespace declarations. */
function uses(xml: string, root: string, prefix: string | undefined): boolean {
  if (!prefix) {
    return false;
  }
  const body = xml.replace(root, "");
  return new RegExp(`[<\\s]${prefix}:[\\w.-]+`).test(body);
}

export function detectPlatform(xml: string): PlatformId {
  const root = ROOT_TAG.exec(xml)?.[0] ?? "";
  const named = EXECUTION_PLATFORM.exec(root)?.[1]?.trim().toLowerCase();
  if (named !== undefined && PLATFORM_NAMES[named]) {
    return PLATFORM_NAMES[named];
  }
  const c7 = uses(xml, root, prefixOf(root, CAMUNDA_URI));
  const c8 = uses(xml, root, prefixOf(root, ZEEBE_URI));
  if (c7 === c8) {
    return "design";
  }
  return c8 ? "c8" : "c7";
}
