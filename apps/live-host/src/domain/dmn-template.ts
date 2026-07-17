/**
 * The blank-decision DMN a created decision starts from — pure string assembly
 * (unit-tested in test/scaffold.test.ts), the dmn sibling of bpmn-template.ts.
 * The shape is the MINIMAL model dmn-js opens with all views intact: one
 * decision holding an empty decision table (one input, one output, no rules)
 * plus DMNDI for the DRD. The decision's XML id follows the same NCName rule
 * as processes (xmlProcessId) — links resolve against the FILE STEM, never
 * the XML id.
 */
import { escapeXml, xmlProcessId } from "./bpmn-template.ts";

/** the initial content of a newly created decision file */
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
