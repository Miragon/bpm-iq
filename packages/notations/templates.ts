/**
 * The template capability: blank-model file content per notation, keyed by
 * descriptor id. templateFor() is the generic dispatch the noun-driven create
 * path consumes (epic #118 step 5); the typed creates (live-host scaffold)
 * keep the named builders.
 *
 * Moved here from the live-host domain (epic #118 step 3) so creating a model
 * of ANY notation with a template becomes one registry lookup. Pure string
 * assembly, zero-dep and browser-safe like the package index.
 */

/** escape a string for use inside an XML attribute value */
export function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * XML ids are NCNames — they must not start with a digit, while a file stem
 * (the process id) may. Prefix such ids so "2nd-level-support.bpmn" still
 * yields a valid model; callActivity links resolve against the FILE STEM,
 * never the XML id, so the prefix is invisible to the platform.
 */
export function xmlProcessId(id: string): string {
  return /^[A-Za-z_]/.test(id) ? id : `p-${id}`;
}

/**
 * The initial content of a newly created process file — the MINIMAL model
 * that passes the platform validator with zero errors: start → end with one
 * sequence flow and complete BPMNDI (a lone start event would be a "dead
 * end"). A collaboration pool carries the human title so the derived process
 * view (./derive: name = the single pool's name) shows it.
 */
export function newBpmnXml(id: string, name: string): string {
  const xmlId = xmlProcessId(id);
  const title = escapeXml(name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_${xmlId}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collaboration_${xmlId}">
    <bpmn:participant id="Participant_${xmlId}" name="${title}" processRef="${xmlId}" />
  </bpmn:collaboration>
  <bpmn:process id="${xmlId}" name="${title}" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Process started">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:endEvent id="EndEvent_1" name="Process completed">
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="EndEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_${xmlId}">
    <bpmndi:BPMNPlane id="BPMNPlane_${xmlId}" bpmnElement="Collaboration_${xmlId}">
      <bpmndi:BPMNShape id="Participant_${xmlId}_di" bpmnElement="Participant_${xmlId}" isHorizontal="true">
        <dc:Bounds x="160" y="80" width="600" height="200" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="232" y="162" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="214" y="205" width="73" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="652" y="162" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="625" y="205" width="90" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="268" y="180" />
        <di:waypoint x="652" y="180" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

/**
 * The initial content of a newly created decision file — the MINIMAL model
 * dmn-js opens with all views intact: one decision holding an empty decision
 * table (one input, one output, no rules) plus DMNDI for the DRD. Same
 * NCName rule as processes (xmlProcessId); links resolve against the FILE
 * STEM, never the XML id.
 */
export function newDmnXml(id: string, name: string): string {
  const xmlId = xmlProcessId(id);
  const title = escapeXml(name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:di="http://www.omg.org/spec/DMN/20180521/DI/" id="Definitions_${xmlId}" name="${title}" namespace="http://bpmiq.dev/dmn/${xmlId}">
  <decision id="${xmlId}" name="${title}">
    <decisionTable id="DecisionTable_${xmlId}" hitPolicy="UNIQUE">
      <input id="Input_1">
        <inputExpression id="InputExpression_1" typeRef="string">
          <text></text>
        </inputExpression>
      </input>
      <output id="Output_1" typeRef="string" />
    </decisionTable>
  </decision>
  <dmndi:DMNDI>
    <dmndi:DMNDiagram id="DMNDiagram_${xmlId}">
      <dmndi:DMNShape id="DMNShape_${xmlId}" dmnElementRef="${xmlId}">
        <dc:Bounds height="80" width="180" x="160" y="100" />
      </dmndi:DMNShape>
    </dmndi:DMNDiagram>
  </dmndi:DMNDI>
</definitions>
`;
}

/** one text line, whatever the input: control chars break line-oriented
 *  formats (OWM) and JSON strings get their own escaping. U+2028/U+2029 are
 *  LineTerminators for JS /m regexes — without them here, a pasted separator
 *  would smuggle a second logical line into the "title-only" template. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}

/**
 * The initial content of a new Wardley map — the OWM DSL is line-oriented and
 * lenient; a lone title renders the empty evolution grid in the Miragon
 * modeler and round-trips untouched.
 */
export function newOwmText(_id: string, name: string): string {
  return `title ${oneLine(name)}\n`;
}

/**
 * The initial content of a new Team Topology — EXACTLY the schema-model's
 * canonical serialization (version 2, 2-space indent, no trailing newline):
 * the modeler's first save re-serializes canonically, and a byte-identical
 * template keeps that save from showing up as a phantom diff.
 */
export function newTtJson(_id: string, name: string): string {
  return JSON.stringify({ version: 2, title: oneLine(name), nodes: [], interactions: [], flows: [] }, null, 2);
}

/** the initial content of a new markdown document — a heading with the title */
export function newMarkdownText(_id: string, name: string): string {
  return `# ${oneLine(name)}\n`;
}

const TEMPLATES: Record<string, (id: string, name: string) => string> = {
  bpmn: newBpmnXml,
  dmn: newDmnXml,
  wardley: newOwmText,
  "team-topology": newTtJson,
  markdown: newMarkdownText,
};

/** whether a notation can be CREATED from the platform (drives the web
 *  client's "New" menu and the generic create route) — false means its files
 *  arrive via git only */
export function hasTemplate(notation: string): boolean {
  // Object.hasOwn, NOT `in`: "toString"/"constructor" must never count as
  // template-capable (prototype chain — the bug class #126's review pinned)
  return Object.hasOwn(TEMPLATES, notation);
}

/**
 * THE generic template dispatch: the blank-file content for a notation, or
 * `undefined` when it has no template (such a notation cannot be created
 * from the platform — its files arrive via git).
 */
export function templateFor(notation: string, id: string, name: string): string | undefined {
  // hasOwn-gated: a bare TEMPLATES[notation] would resolve prototype members —
  // templateFor("toString", …) used to return "[object Object]" as a template
  return Object.hasOwn(TEMPLATES, notation) ? TEMPLATES[notation]?.(id, name) : undefined;
}
