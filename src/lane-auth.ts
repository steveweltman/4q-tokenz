import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Hash stored in config. The token itself never lives in config or logs. */
export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf-8").digest("hex")}`;
}

/** Returns the token from an "Authorization: Bearer <token>" header, or null. */
export function extractBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(header);
  return match ? match[1] : null;
}

/** Constant-time comparison of a presented token against a configured hash. */
export function verifyLaneToken(presented: string | null, expectedHash: string | undefined): boolean {
  if (!presented || !expectedHash || !TOKEN_HASH_PATTERN.test(expectedHash)) return false;
  const a = createHash("sha256").update(presented, "utf-8").digest();
  const b = Buffer.from(expectedHash.slice("sha256:".length), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads a lane token from a file the operator controls. Throws a generic error. */
export function readTokenFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    throw new Error("lane token file could not be read");
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(raw)) throw new Error("lane token file has an invalid token");
  return raw;
}

/** Creates a new token file (mode 0600) and returns the hash to put in config. */
export function createTokenFile(path: string, token: string, overwrite: boolean): string {
  if (existsSync(path) && !overwrite) throw new Error("token file already exists (use --rotate to replace it)");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return hashToken(token);
}
