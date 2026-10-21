import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const DIST = join(ROOT, process.env.DIST_DIR || "dist");
export const ENTRY = join(DIST, "index.js");
const STUB = join(here, "fixtures", "stub-upstream.mjs");

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `4q-test-${prefix}-`));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn dist/index.js with a stripped env (no XDG_RUNTIME_DIR, temp HOME),
 * the way the OpenClaw gateway launches it. Never touches real ports or config.
 */
export const LANES = {
  alpha: { allow: ["stub"] },
  beta: { allow: ["stub"], deny: ["stub.ping"] },
};

export function startProxy({ port, dashboardPort, lockDir, agent, service = false, extraEnv = {} }) {
  const home = tempDir("home");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MCP_PROXY_SINGLETON_PORT: String(port),
    MCP_PROXY_DASHBOARD_PORT: String(dashboardPort),
    MCP_PROXY_AGENTS: JSON.stringify(LANES),
    ...(service ? { MCP_PROXY_SERVICE_MODE: "1" } : {}),
    ...(agent ? { MCP_PROXY_AGENT: agent } : {}),
    ...extraEnv,
    MCP_PROXY_UPSTREAMS: JSON.stringify([
      { name: "stub", transport: "stdio", command: process.execPath, args: [STUB] },
    ]),
  };
  if (lockDir) env.MCP_PROXY_LOCK_DIR = lockDir;

  const child = spawn(process.execPath, [ENTRY], { env, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const proc = { child, stderr: "", stdout: "" };
  child.stderr.on("data", (d) => (proc.stderr += d));
  child.stdout.on("data", (d) => (proc.stdout += d));
  proc.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return proc;
}

export async function waitFor(predicate, { timeoutMs = 20000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Send an MCP initialize over stdio and resolve with the parsed response. */
export async function initializeOverStdio(proc) {
  proc.child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }) + "\n",
  );
  await waitFor(() => proc.stdout.includes('"id":1'), { label: "initialize response", timeoutMs: 10000 });
  return JSON.parse(proc.stdout.split("\n").find((l) => l.includes('"id":1')));
}

export function stop(proc) {
  proc.child.kill("SIGTERM");
  return proc.exited;
}
