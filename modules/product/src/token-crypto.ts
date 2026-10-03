import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Access tokens are encrypted at rest with AES-256-GCM using FOUNDEROS_SECRET_KEY (32 bytes, base64).
 * If the key is missing or malformed, tokens are NOT stored (callers use them for a single scan only).
 * Stored format: "v1.<iv>.<tag>.<ciphertext>" (base64url). The business id is bound as additional authenticated data.
 */

export function getSecretKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.FOUNDEROS_SECRET_KEY?.trim();
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function encryptToken(token: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(stored: string, key: Buffer, aad: string): string | null {
  try {
    const [v, iv, tag, ct] = stored.split(".");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
