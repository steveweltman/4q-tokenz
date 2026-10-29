#!/usr/bin/env node
// Usage: lane-token <agent> [--dir <dir>] [--rotate]
// Writes a fresh random token to <dir>/<agent> (0600) and prints only the config hash.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTokenFile } from "./lane-auth.js";
import { AGENT_ID_PATTERN } from "./types.js";

const args = process.argv.slice(2);
const agent = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--dir");
const dirIndex = args.indexOf("--dir");
const dir = dirIndex >= 0 ? args[dirIndex + 1] : join(homedir(), ".config", "4q-tokens", "lane-tokens");

if (!agent || !AGENT_ID_PATTERN.test(agent) || !dir) {
  console.error("usage: lane-token <agent> [--dir <dir>] [--rotate]");
  process.exit(2);
}
try {
  const token = randomBytes(32).toString("base64url");
  const hash = createTokenFile(join(dir, agent), token, args.includes("--rotate"));
  console.log(JSON.stringify({ agent, tokenFile: join(dir, agent), tokenHash: hash }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
}
