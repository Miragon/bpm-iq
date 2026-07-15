/**
 * AES-256-GCM at-rest cipher over any secret string (sha256-derived 32-byte key).
 * Shared by the token cache (repos/token-minter.ts) and the session store
 * (auth/sessions.ts) so persisted GitHub credentials are never on disk in cleartext.
 *
 * enc → "iv.tag.ct" (base64); dec → plaintext, or undefined when the blob is
 * malformed / the auth tag fails / the key rotated — callers treat that as "absent"
 * and re-authenticate rather than crashing. Returns undefined when no key is set.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface Cipher {
  enc(plain: string): string;
  dec(blob: string): string | undefined;
}

export function makeCipher(key: string | undefined): Cipher | undefined {
  if (!key) return undefined;
  const k = createHash("sha256").update(key).digest(); // 32 bytes from any secret
  return {
    enc(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", k, iv);
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
    },
    dec(blob: string): string | undefined {
      try {
        const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64"));
        if (!iv || !tag || !ct) return undefined; // not the iv.tag.ct shape
        const d = createDecipheriv("aes-256-gcm", k, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
      } catch {
        return undefined; // key rotated / corrupt / cleartext legacy row → ignore
      }
    },
  };
}
