/**
 * @bpmiq/github-app — the shared GitHub App key primitives. appJwt is checked
 * against a freshly generated RSA keypair (signature + claims); loadPrivateKey
 * covers all four sources and their precedence, including the *.pem auto-detect
 * that used to exist on only one of the two callers.
 */
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appJwt, loadPrivateKey } from "../src/index.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const NOW = 1_700_000_000_000; // fixed epoch ms

const mkTmp = () => mkdtempSync(join(tmpdir(), "gh-app-"));

// ── appJwt ──────────────────────────────────────────────────────────────────

test("appJwt: three base64url parts, signature verifies against the public key", () => {
  const parts = appJwt({ appId: "12345", privateKey: PEM }, NOW).split(".");
  assert.equal(parts.length, 3, "header.payload.signature");
  const [h, p, sig] = parts as [string, string, string];
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, "base64url")), "signature must verify");
});

test("appJwt: RS256 header + iss/iat(-60s)/exp(+540s) claims", () => {
  const sec = Math.floor(NOW / 1000);
  const [h, p] = appJwt({ appId: "42", privateKey: PEM }, NOW).split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { iat: sec - 60, exp: sec + 540, iss: "42" });
});

test("appJwt: deterministic for a fixed key + time", () => {
  // the property that made two copies risky — identical inputs yield identical tokens
  assert.equal(appJwt({ appId: "1", privateKey: PEM }, NOW), appJwt({ appId: "1", privateKey: PEM }, NOW));
});

// ── loadPrivateKey ──────────────────────────────────────────────────────────

test("loadPrivateKey: 1) raw PEM in GITHUB_APP_PRIVATE_KEY wins", () => {
  const raw = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----"; // gitleaks:allow — fixture, body is literally "x"
  assert.equal(loadPrivateKey({ GITHUB_APP_PRIVATE_KEY: raw }), raw);
});

test("loadPrivateKey: a raw value that isn't a PEM is ignored", () => {
  assert.equal(loadPrivateKey({ GITHUB_APP_PRIVATE_KEY: "oops-not-a-key" }), undefined);
});

test("loadPrivateKey: 2) FILE reads the path", () => {
  const f = join(mkTmp(), "key.pem");
  writeFileSync(f, "FILE-PEM");
  assert.equal(loadPrivateKey({ GITHUB_APP_PRIVATE_KEY_FILE: f }), "FILE-PEM");
});

test("loadPrivateKey: 3) B64 decodes to the PEM", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
  assert.equal(loadPrivateKey({ GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(key).toString("base64") }), key);
});

test("loadPrivateKey: 4) auto-detects the first *.pem in pemDir (drift fix — now shared)", () => {
  const dir = mkTmp();
  writeFileSync(join(dir, "b.pem"), "B");
  writeFileSync(join(dir, "a.pem"), "A"); // sort()[0] → a.pem
  writeFileSync(join(dir, "notes.txt"), "ignored");
  assert.equal(loadPrivateKey({}, { pemDir: dir }), "A");
});

test("loadPrivateKey: precedence — raw beats b64 beats pemDir", () => {
  const dir = mkTmp();
  writeFileSync(join(dir, "x.pem"), "PEMDIR");
  const raw = "-----BEGIN PRIVATE KEY-----\nR\n-----END PRIVATE KEY-----";
  const got = loadPrivateKey(
    { GITHUB_APP_PRIVATE_KEY: raw, GITHUB_APP_PRIVATE_KEY_B64: Buffer.from("B64").toString("base64") },
    { pemDir: dir },
  );
  assert.equal(got, raw);
});

test("loadPrivateKey: undefined when nothing is configured (cell mode carries no key)", () => {
  assert.equal(loadPrivateKey({}, {}), undefined);
  assert.equal(loadPrivateKey({}), undefined);
});
