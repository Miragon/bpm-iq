/**
 * Pins the web-app deep-link URL shapes — three surfaces build them (issue
 * bodies, open_modeler results, the widget button), so a drift here is a
 * broken link on all of them. The expectations mirror the pre-extraction
 * behaviour pinned in apps/live-host/test/todo-issues.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fileDeepLink, processDeepLink } from "../src/deep-link.ts";

test("processDeepLink: /r/<owner>/<repo>/p/<id>, trailing slash stripped, segments encoded", () => {
  assert.equal(
    processDeepLink("https://bpm.example/", "acme/bpm-processes", "order-to-cash"),
    "https://bpm.example/r/acme/bpm-processes/p/order-to-cash",
  );
  // ?element= rides encoded; ids may carry spaces (imported models)
  assert.equal(
    processDeepLink("https://bpm.example", "acme/bpm-processes", "order-to-cash", "Gateway 1"),
    "https://bpm.example/r/acme/bpm-processes/p/order-to-cash?element=Gateway%201",
  );
});

test("processDeepLink: the repo splits at the FIRST slash (GitLab subgroups stay in the repo segment)", () => {
  assert.equal(
    processDeepLink("https://bpm.example", "group/sub/name", "order-to-cash"),
    "https://bpm.example/r/group/sub%2Fname/p/order-to-cash",
  );
});

test("fileDeepLink: /r/<owner>/<repo>/f/<path> — slashes keep separating the splat segments", () => {
  assert.equal(
    fileDeepLink("https://bpm.example", "acme/bpm-processes", "processes/rabatt.dmn"),
    "https://bpm.example/r/acme/bpm-processes/f/processes/rabatt.dmn",
  );
  // a segment with reserved characters is encoded WITHIN its segment
  assert.equal(
    fileDeepLink("https://bpm.example", "acme/bpm-processes", "processes/preis rabatt.dmn"),
    "https://bpm.example/r/acme/bpm-processes/f/processes/preis%20rabatt.dmn",
  );
});
