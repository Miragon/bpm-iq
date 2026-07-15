/**
 * TokenService — in-memory caching + SQLite degraded-mode survival (ADR 0002
 * blocker T) + at-rest encryption. Pure unit test, no network.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { type MintFn, TokenService } from "../src/repos/token-minter.ts";

const hour = 60 * 60_000;

test("caches in memory: a fresh token is not re-minted within the 5-min margin", async () => {
  let mints = 0;
  const mintFn: MintFn = async () => {
    mints++;
    return { token: `t${mints}`, expiresAt: Date.now() + hour };
  };
  const svc = new TokenService(mintFn);
  assert.equal(await svc.mint(1), "t1");
  assert.equal(await svc.mint(1), "t1");
  assert.equal(mints, 1);
});

test("single-flight: concurrent mints collapse into one upstream call", async () => {
  let mints = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mintFn: MintFn = async () => {
    mints++;
    await gate;
    return { token: "t", expiresAt: Date.now() + hour };
  };
  const svc = new TokenService(mintFn);
  const calls = [svc.mint(1), svc.mint(1), svc.mint(1)]; // three concurrent room-joins
  release();
  assert.deepEqual(await Promise.all(calls), ["t", "t", "t"]);
  assert.equal(mints, 1, "one upstream mint served all three callers");
});

test("degraded mode: serves a persisted still-valid token when minting fails", async () => {
  const db = new DatabaseSync(":memory:");
  let fail = false;
  const mintFn: MintFn = async () => {
    if (fail) throw new Error("control plane 503");
    return { token: "good", expiresAt: Date.now() + hour };
  };

  const svc1 = new TokenService(mintFn, { db });
  assert.equal(await svc1.mint(7), "good"); // mints + persists

  // a FRESH service (simulating a restarted cell with an empty memory cache)
  // whose minter is now down must still serve the persisted token
  fail = true;
  const svc2 = new TokenService(mintFn, { db });
  assert.equal(await svc2.mint(7), "good", "persisted token served during outage");
});

test("degraded mode does NOT serve an (almost) expired persisted token", async () => {
  const db = new DatabaseSync(":memory:");
  // persist a token that expires in 30s via a service whose mint returns it once
  const nearlyExpired: MintFn = async () => ({ token: "stale", expiresAt: Date.now() + 30_000 });
  await new TokenService(nearlyExpired, { db }).mint(9);

  const down: MintFn = async () => {
    throw new Error("down");
  };
  const svc = new TokenService(down, { db });
  await assert.rejects(() => svc.mint(9), /down/, "must not serve a token with <1min left");
});

test("at-rest encryption: persisted token is not stored in plaintext", async () => {
  const db = new DatabaseSync(":memory:");
  const mintFn: MintFn = async () => ({ token: "secret-token-value", expiresAt: Date.now() + hour });
  const svc = new TokenService(mintFn, { db, encryptionKey: "cell-secret" });
  await svc.mint(3);
  const row = db.prepare("SELECT token FROM installation_tokens WHERE installation_id = 3").get() as { token: string };
  assert.ok(!row.token.includes("secret-token-value"), "token must be encrypted at rest");

  // a service with the SAME key can decrypt and serve it during an outage
  const down: MintFn = async () => {
    throw new Error("down");
  };
  const svc2 = new TokenService(down, { db, encryptionKey: "cell-secret" });
  assert.equal(await svc2.mint(3), "secret-token-value");

  // a service with the WRONG key cannot use the persisted token → must re-mint (and fail)
  const svc3 = new TokenService(down, { db, encryptionKey: "wrong-key" });
  await assert.rejects(() => svc3.mint(3), /down/);
});
