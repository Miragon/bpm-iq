/**
 * package.json against the literals the code and the Live Host rely on — the
 * manifest is plain JSON nobody type-checks, so a rename that misses one side
 * fails here instead of in a sign-in that never comes back.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EDITOR_EXTENSION_ID } from "@designiq/contracts/live";

import { SCHEME } from "../../scheme.ts";

interface Manifest {
  name: string;
  publisher: string;
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    configuration: { properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as Manifest;

test("the Live Host's callback target is this extension's id (publisher.name)", () => {
  // editor-login.ts builds <scheme>://EDITOR_EXTENSION_ID/auth — VS Code routes
  // it to the extension whose publisher.name matches, or to nobody
  assert.equal(EDITOR_EXTENSION_ID, `${manifest.publisher}.${manifest.name}`);
});

test("the file system scheme activates the extension", () => {
  assert.ok(manifest.activationEvents.includes(`onFileSystem:${SCHEME}`), "onFileSystem activation event");
});

test("commands and settings share the designiq. prefix; titles carry no hard-coded product prefix", () => {
  for (const c of manifest.contributes.commands) {
    assert.match(c.command, /^designiq\./, c.command);
    assert.equal(c.category, "designIQ", `${c.command} category`);
    assert.ok(!c.title.includes(":"), `${c.command} title "${c.title}" — the category renders the prefix`);
  }
  for (const key of Object.keys(manifest.contributes.configuration.properties)) {
    assert.match(key, /^designiq\./, key);
  }
});
