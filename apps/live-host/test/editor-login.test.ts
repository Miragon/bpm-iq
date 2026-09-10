/**
 * Editor sign-in (src/http/editor-login.ts): the pure parts — parameter
 * validation (the scheme is the only caller-controlled piece of the return
 * target), the cookie round-trip, the return URI and the landing page's
 * escaping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeEditorCookie,
  editorReturnPage,
  editorReturnUri,
  encodeEditorCookie,
  parseEditorLogin,
} from "../src/http/editor-login.ts";

const NONCE = "abcDEF123_-xyz";

test("parseEditorLogin: absent → undefined (a browser login), valid → the pair", () => {
  assert.equal(parseEditorLogin(new URLSearchParams("")), undefined);
  assert.deepEqual(parseEditorLogin(new URLSearchParams({ editor: "vscode", editor_state: NONCE })), {
    scheme: "vscode",
    state: NONCE,
  });
  assert.deepEqual(parseEditorLogin(new URLSearchParams({ editor: "vscode-insiders", editor_state: NONCE })), {
    scheme: "vscode-insiders",
    state: NONCE,
  });
});

test("parseEditorLogin: half a pair or a malformed part → null (the route 400s)", () => {
  assert.equal(parseEditorLogin(new URLSearchParams({ editor: "vscode" })), null, "state missing");
  assert.equal(parseEditorLogin(new URLSearchParams({ editor_state: NONCE })), null, "scheme missing");
  // a scheme is not a URL — no authority, no path, no javascript: tricks
  for (const bad of ["Vscode", "vs code", "vscode://x", "https://evil.example", "", "javascript:alert(1)"]) {
    assert.equal(parseEditorLogin(new URLSearchParams({ editor: bad, editor_state: NONCE })), null, `scheme ${bad}`);
  }
  for (const bad of ["short", "has space here", "semi;colon", "a".repeat(129)]) {
    assert.equal(parseEditorLogin(new URLSearchParams({ editor: "vscode", editor_state: bad })), null, `state ${bad}`);
  }
});

test("cookie round-trip; a tampered cookie decodes to nothing", () => {
  const login = { scheme: "cursor", state: NONCE };
  assert.deepEqual(decodeEditorCookie(encodeEditorCookie(login)), login);
  assert.equal(decodeEditorCookie(undefined), undefined);
  assert.equal(decodeEditorCookie("no-colon"), undefined);
  assert.equal(decodeEditorCookie("https://evil.example:" + NONCE), undefined);
});

test("the return URI targets the fixed extension id with code + state only", () => {
  const uri = editorReturnUri({ scheme: "vscode", state: NONCE }, "c0de");
  assert.equal(uri, `vscode://miragon-gmbh.bpm-live/auth?code=c0de&state=${NONCE}`);
});

test("the landing page escapes the URI and the login", () => {
  const page = editorReturnPage("vscode://miragon-gmbh.bpm-live/auth?code=c&state=s", '<img onerror="x">');
  assert.ok(page.includes('content="0;url=vscode://miragon-gmbh.bpm-live/auth?code=c&amp;state=s"'));
  assert.ok(page.includes('href="vscode://miragon-gmbh.bpm-live/auth?code=c&amp;state=s"'));
  assert.ok(!page.includes("<img"), "login escaped");
  assert.ok(page.includes("&lt;img onerror=&quot;x&quot;&gt;"));
});
