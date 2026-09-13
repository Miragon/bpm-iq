import assert from "node:assert/strict";
import { test } from "node:test";

import { hostUrls, loginStartUrl, parseLoginCallback } from "../../login-flow.ts";

test("hostUrls: http and ws forms from either setting form, trailing slashes dropped", () => {
  assert.deepEqual(hostUrls("http://localhost:8301/"), { http: "http://localhost:8301", ws: "ws://localhost:8301" });
  assert.deepEqual(hostUrls("ws://localhost:8301"), { http: "http://localhost:8301", ws: "ws://localhost:8301" });
  assert.deepEqual(hostUrls(" wss://live.example.com "), {
    http: "https://live.example.com",
    ws: "wss://live.example.com",
  });
});

test("loginStartUrl carries the editor pair the Live Host expects", () => {
  const url = new URL(loginStartUrl("https://live.example.com", "oidc", "vscode-insiders", "n0nce_-abc"));
  assert.equal(url.pathname, "/auth/oidc");
  assert.equal(url.searchParams.get("editor"), "vscode-insiders");
  assert.equal(url.searchParams.get("editor_state"), "n0nce_-abc");
});

test("parseLoginCallback: only the sign-in path with both parameters", () => {
  assert.deepEqual(parseLoginCallback("/auth", "code=c0de&state=n0nce"), { code: "c0de", state: "n0nce" });
  assert.equal(parseLoginCallback("/other", "code=c0de&state=n0nce"), undefined);
  assert.equal(parseLoginCallback("/auth", "code=c0de"), undefined);
  assert.equal(parseLoginCallback("/auth", ""), undefined);
});
