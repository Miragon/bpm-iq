/**
 * The blank-diagram BPMN a created process starts from — pure string assembly
 * (unit-tested in test/scaffold.test.ts). The shape is the MINIMAL model that
 * passes the platform validator with zero errors: start → end with one
 * sequence flow and complete BPMNDI (a lone start event would be a "dead end").
 * A collaboration pool carries the human title so the derived process view
 * (@bpmiq/notations/derive: name = the single pool's name) shows it.
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

/** the initial content of a newly created process file */
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
