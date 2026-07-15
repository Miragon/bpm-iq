/** @bpmiq/http-kit — the shared primitives both backends build on. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import {
  bearerAuth,
  hmac,
  readBody,
  readCookie,
  securityHeaders,
  send,
  tag,
  timingSafeStr,
  untag,
} from "../src/index.ts";

/** minimal ServerResponse double capturing writeHead/setHeader/end */
function fakeRes() {
  const state = {
    status: 0,
    headers: {} as Record<string, unknown>,
    setHeaders: {} as Record<string, unknown>,
    body: "",
  };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status;
      state.headers = headers;
      return res;
    },
    setHeader(name: string, value: unknown) {
      state.setHeaders[name] = value;
    },
    end(text?: string) {
      state.body = text ?? "";
    },
  } as unknown as ServerResponse;
  return { res, state };
}

test("send: JSON body gets application/json + no-store; string body is plain text", () => {
  const a = fakeRes();
  send(a.res, 200, { ok: true });
  assert.equal(a.state.status, 200);
  assert.equal(a.state.headers["content-type"], "application/json");
  assert.equal(a.state.headers["cache-control"], "no-store");
  assert.equal(a.state.body, '{"ok":true}');

  const b = fakeRes();
  send(b.res, 400, "bad", { "x-extra": "1" });
  assert.equal(b.state.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(b.state.headers["x-extra"], "1");
});

test("readBody: caps the body and STOPS buffering after the reject (the drift bug)", async () => {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  let destroyed = false;
  (req as unknown as { destroy: () => void }).destroy = () => {
    destroyed = true;
  };
  const p = readBody(req, { maxBytes: 10 });
  p.catch(() => undefined); // attach early — the reject fires synchronously below
  req.emit("data", Buffer.alloc(8));
  req.emit("data", Buffer.alloc(8)); // 16 > 10 → reject
  await assert.rejects(p, /body too large/);
  assert.ok(destroyed, "request destroyed at the cap");
  // more data after the reject must not throw or accumulate
  req.emit("data", Buffer.alloc(1024));
});

test("readBody: happy path concatenates chunks", async () => {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as unknown as { destroy: () => void }).destroy = () => {};
  const p = readBody(req);
  req.emit("data", Buffer.from("hello "));
  req.emit("data", Buffer.from("world"));
  req.emit("end");
  assert.equal((await p).toString(), "hello world");
});

test("securityHeaders: 4 headers when secure, HSTS omitted on plain http", () => {
  const a = fakeRes();
  securityHeaders(a.res, { secure: true });
  assert.equal(a.state.setHeaders["x-content-type-options"], "nosniff");
  assert.equal(a.state.setHeaders["referrer-policy"], "no-referrer");
  assert.equal(a.state.setHeaders["content-security-policy"], "frame-ancestors 'none'");
  assert.match(String(a.state.setHeaders["strict-transport-security"]), /max-age/);

  const b = fakeRes();
  securityHeaders(b.res, { secure: false });
  assert.equal(b.state.setHeaders["strict-transport-security"], undefined, "no HSTS over http (dev)");
});

test("readCookie: picks one value, trims, empty value → undefined", () => {
  assert.equal(readCookie("a=1; b=2; c=3", "b"), "2");
  assert.equal(readCookie("a=1;   spaced=ok", "spaced"), "ok");
  assert.equal(readCookie("a=", "a"), undefined);
  assert.equal(readCookie(undefined, "a"), undefined);
  assert.equal(readCookie("a=1", "missing"), undefined);
});

test("tag/untag: round-trips; tampered data or mac is rejected; inner dots survive", () => {
  const secret = Buffer.from("s3cret");
  const token = tag(secret, "github.nonce-with.dots");
  assert.equal(untag(secret, token), "github.nonce-with.dots");
  assert.equal(untag(secret, `${token}x`), undefined, "tampered mac");
  assert.equal(untag(secret, `x${token}`), undefined, "tampered data");
  assert.equal(untag(Buffer.from("other"), token), undefined, "wrong secret");
  assert.equal(untag(secret, "no-dot"), undefined);
});

test("timingSafeStr + bearerAuth: constant-time equality semantics", () => {
  assert.ok(timingSafeStr("abc", "abc"));
  assert.equal(timingSafeStr("abc", "abd"), false);
  assert.equal(timingSafeStr("abc", "abcd"), false, "length mismatch is safe, not an exception");
  const req = { headers: { authorization: "Bearer tok-1" } } as unknown as IncomingMessage;
  assert.ok(bearerAuth(req, "tok-1"));
  assert.equal(bearerAuth(req, "tok-2"), false);
  assert.equal(bearerAuth({ headers: {} } as IncomingMessage, "tok-1"), false);
});

test("hmac: stable base64url", () => {
  assert.equal(hmac("k", "data"), hmac(Buffer.from("k"), "data"));
  assert.doesNotMatch(hmac("k", "data"), /[+/=]/, "base64url alphabet");
});
