/**
 * The `bpmiq` moddle extension (#117): sticky notes as BPMN extension
 * elements plus the per-document t.BPM maturity flag.
 *
 * `bpmiq:Sticky` deliberately does NOT extend bpmn:BaseElement — bpmn-js'
 * BpmnUpdater gates every DI/parent hook on `is(element, 'bpmn:BaseElement')`
 * (ifBpmn), so a non-BPMN superclass keeps the whole DI machinery away from
 * stickies: their coordinates live on the extension element itself and no
 * BPMNDI entry ever exists (hard rule 2 stays clean). BPMN 2.0 obliges
 * compliant tools to preserve foreign extensionElements, so a workshop file
 * opened in Camunda Modeler survives untouched.
 */
export const bpmiqModdle = {
  // FROZEN — these never follow a product rename. uri + prefix are written
  // into every customer .bpmn that ever held a sticky or the workshop flag
  // (the xmlns declaration, the sticky tag, the mode attribute). Rename both
  // and such a file still opens without an error, but its stickies and the
  // workshop mode silently vanish from canvas and Notes panel; rename only the
  // uri and saveXML throws. Pinned by test/sticky-namespace.test.ts.
  name: "bpmiq", // legacy-name-ok: moddle never reads it — kept equal to the frozen prefix
  uri: "https://bpmiq.io/schema/1.0/bpmiq", // legacy-name-ok: persisted in customer .bpmn files
  prefix: "bpmiq", // legacy-name-ok: persisted in customer .bpmn files
  xml: { tagAlias: "lowerCase" },
  types: [
    {
      name: "Sticky",
      superClass: ["Element"],
      properties: [
        { name: "id", type: "String", isAttr: true, isId: true },
        // attr, not body: ONE line of XML per sticky — a PR diff of a
        // workshop session touches exactly the stickies that changed
        { name: "text", type: "String", isAttr: true },
        { name: "x", type: "Integer", isAttr: true },
        { name: "y", type: "Integer", isAttr: true },
        { name: "kind", type: "String", isAttr: true },
        { name: "width", type: "Integer", isAttr: true },
        { name: "height", type: "Integer", isAttr: true },
      ],
    },
    {
      // bpmiq:mode="workshop|full" on bpmn:Definitions — the per-DOCUMENT
      // switch #54's reduced palette keys on (all participants see the same
      // tools; a client toggle could not guarantee that)
      name: "ModeDefinitions",
      extends: ["bpmn:Definitions"],
      properties: [{ name: "mode", type: "String", isAttr: true }],
    },
  ],
};
