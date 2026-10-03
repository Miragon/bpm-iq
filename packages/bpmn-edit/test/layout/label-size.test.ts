import assert from "node:assert/strict";
import { test } from "node:test";

import { labelSize } from "../../src/layout/label-size.ts";

test("labelSize puts a shape label on two compact lines that bpmn-js keeps, a short one on one line", () => {
  assert.deepEqual(labelSize("Stimmt HomeID mit HomeIdConnectivity überein?"), { width: 150, height: 28 });
  assert.deepEqual(labelSize("Rückmeldungstyp?"), { width: 100, height: 14 });
});

test("labelSize avoids a width where bpmn-js would break the label once more when it draws it", () => {
  // at 90 px bpmn-js lays it out on two lines, then breaks "TVS Schleife" apart at the width of that line
  assert.deepEqual(labelSize("TVS Schleife beenden"), { width: 115, height: 14 });
});

test("labelSize keeps a flow label on one line, and the line breaks its author typed", () => {
  assert.equal(labelSize("Port und Slot anfragen und manuell setzen?", 1).height, 14);
  assert.equal(labelSize("SPRI:\nNEU").height, 28);
});

test("labelSize breaks a word at the soft hyphen its author put in, as bpmn-js does", () => {
  const soft = labelSize("Antragsbearbeitungs­vorgang jetzt abschliessen");
  const hard = labelSize("Antragsbearbeitungs-vorgang jetzt abschliessen");

  assert.deepEqual(soft, hard);
});
