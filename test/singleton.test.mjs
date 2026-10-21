import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir, freePort } from "./helpers.mjs";
import { DIST } from "./helpers.mjs";

const { tryAcquireLock, readLock, releaseLock, isPortInUse } = await import(join(DIST, "singleton.js"));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("lock dir: MCP_PROXY_LOCK_DIR wins over XDG_RUNTIME_DIR", () => {
  const lockDir = tempDir("lock");
  const xdg = tempDir("xdg");
  withEnv({ MCP_PROXY_LOCK_DIR: lockDir, XDG_RUNTIME_DIR: xdg }, () => {
    assert.equal(tryAcquireLock(9999), true);
    assert.ok(existsSync(join(lockDir, "mcp-proxy.lock")));
    assert.ok(!existsSync(join(xdg, "mcp-proxy.lock")));
    releaseLock();
  });
});

test("lock dir: XDG_RUNTIME_DIR used when no override", () => {
  const xdg = tempDir("xdg");
  withEnv({ MCP_PROXY_LOCK_DIR: undefined, XDG_RUNTIME_DIR: xdg }, () => {
    assert.equal(tryAcquireLock(9999), true);
    assert.ok(existsSync(join(xdg, "mcp-proxy.lock")));
    releaseLock();
  });
});

test("second acquire fails while the holder is alive and reports its pid and port", () => {
  const lockDir = tempDir("lock");
  withEnv({ MCP_PROXY_LOCK_DIR: lockDir }, () => {
    assert.equal(tryAcquireLock(1234), true);
    assert.equal(tryAcquireLock(1234), false);
    assert.deepEqual(readLock(), { pid: process.pid, port: 1234 });
    releaseLock();
    assert.equal(readLock(), null);
  });
});

test("a stale lock from a dead pid is taken over", async () => {
  const lockDir = tempDir("lock");
  const { writeFileSync } = await import("node:fs");
  // pid beyond any realistic pid_max, so it is never alive
  writeFileSync(join(lockDir, "mcp-proxy.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, port: 1 }));
  withEnv({ MCP_PROXY_LOCK_DIR: lockDir }, () => {
    assert.equal(tryAcquireLock(4321), true);
    assert.deepEqual(readLock(), { pid: process.pid, port: 4321 });
    releaseLock();
  });
});

test("isPortInUse: true for a listening socket, false once closed", async () => {
  const port = await freePort();
  assert.equal(await isPortInUse(port), false);
  const srv = createServer();
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  assert.equal(await isPortInUse(port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await isPortInUse(port), false);
});
