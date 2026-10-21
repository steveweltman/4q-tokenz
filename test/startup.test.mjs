import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  tempDir,
  freePort,
  startProxy,
  waitFor,
  initializeOverStdio,
  stop,
} from "./helpers.mjs";

async function startPrimary() {
  const port = await freePort();
  const dashboardPort = await freePort();
  const lockDir = tempDir("lock");
  const primary = startProxy({ port, dashboardPort, lockDir });
  await waitFor(() => primary.stderr.includes("HTTP transport listening"), {
    label: "primary listening",
  });
  return { primary, port, dashboardPort, lockDir };
}

test("free port: instance becomes the primary", async () => {
  const { primary, lockDir } = await startPrimary();
  try {
    assert.match(primary.stderr, /PRIMARY mode/);
    assert.ok(existsSync(join(lockDir, "mcp-proxy.lock")));
  } finally {
    await stop(primary);
  }
});

test("same lock dir: second instance bridges and completes the MCP handshake", async () => {
  const { primary, port, dashboardPort, lockDir } = await startPrimary();
  const second = startProxy({ port, dashboardPort, lockDir });
  try {
    const res = await initializeOverStdio(second);
    assert.equal(res.result.serverInfo.name, "mcp-proxy-bridge");
    assert.match(second.stderr, /BRIDGE mode/);
  } finally {
    await stop(second);
    await stop(primary);
  }
});

test("regression: different lock dir (gateway-style env) bridges instead of crashing with EADDRINUSE", async () => {
  const { primary, port, dashboardPort } = await startPrimary();
  const otherLockDir = tempDir("otherlock");
  const second = startProxy({ port, dashboardPort, lockDir: otherLockDir });
  try {
    const res = await initializeOverStdio(second);
    assert.equal(res.result.serverInfo.name, "mcp-proxy-bridge");
    assert.match(second.stderr, /already served; releasing lock and running as BRIDGE/);
    assert.doesNotMatch(second.stderr, /EADDRINUSE/);
    assert.ok(!existsSync(join(otherLockDir, "mcp-proxy.lock")), "stray lock must be released");
  } finally {
    await stop(second);
    await stop(primary);
  }
});
