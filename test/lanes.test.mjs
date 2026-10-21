import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  tempDir,
  freePort,
  startProxy,
  waitFor,
  initializeOverStdio,
  stop,
} from "./helpers.mjs";

async function startServicePrimary() {
  const port = await freePort();
  const dashboardPort = await freePort();
  const lockDir = tempDir("lock");
  const primary = startProxy({ port, dashboardPort, lockDir, service: true });
  await waitFor(() => primary.stderr.includes("Agent isolation: ENABLED"), { label: "lanes ready" });
  return { primary, port, dashboardPort, lockDir };
}

async function searchOnLane(port, lane, query) {
  const client = new Client({ name: "lane-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${lane}`)));
  try {
    const res = await client.callTool({ name: "mcp_search", arguments: { query } });
    return res.content.map((c) => c.text).join("");
  } finally {
    await client.close();
  }
}

test("unscoped /mcp session is refused with 403 (fail closed)", async () => {
  const { primary, port } = await startServicePrimary();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    assert.equal(res.status, 403);
  } finally {
    await stop(primary);
  }
});

test("unknown lane is refused with 404", async () => {
  const { primary, port } = await startServicePrimary();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/nobody`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    assert.equal(res.status, 404);
  } finally {
    await stop(primary);
  }
});

test("lane deny list hides a tool on one lane and not on another", async () => {
  const { primary, port } = await startServicePrimary();
  try {
    assert.match(await searchOnLane(port, "alpha", "ping"), /stub\.ping/);
    assert.doesNotMatch(await searchOnLane(port, "beta", "ping"), /stub\.ping/);
  } finally {
    await stop(primary);
  }
});

test("a bridge bound to a lane reaches only that lane", async () => {
  const { primary, port, dashboardPort, lockDir } = await startServicePrimary();
  const bridge = startProxy({ port, dashboardPort, lockDir, agent: "beta" });
  try {
    await initializeOverStdio(bridge);
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_search", arguments: { query: "ping" } } }) + "\n");
    await waitFor(() => bridge.stdout.includes('"id":2'), { label: "search response" });
    const line = bridge.stdout.split("\n").find((l) => l.includes('"id":2'));
    assert.doesNotMatch(line, /stub\.ping/);
  } finally {
    await stop(bridge);
    await stop(primary);
  }
});

test("a bridge without MCP_PROXY_AGENT refuses to start", async () => {
  const { primary, port, dashboardPort, lockDir } = await startServicePrimary();
  const bridge = startProxy({ port, dashboardPort, lockDir });
  try {
    const code = await bridge.exited;
    assert.equal(code, 1);
    assert.match(bridge.stderr, /MCP_PROXY_AGENT is not set/);
  } finally {
    await stop(primary);
  }
});

test("a bridge with an invalid agent id refuses to start", async () => {
  const { primary, port, dashboardPort, lockDir } = await startServicePrimary();
  const bridge = startProxy({ port, dashboardPort, lockDir, agent: "../etc" });
  try {
    assert.equal(await bridge.exited, 1);
    assert.match(bridge.stderr, /not a valid agent id/);
  } finally {
    await stop(primary);
  }
});

test("a non-service primary refuses to serve an unscoped stdio pool", async () => {
  const port = await freePort();
  const dashboardPort = await freePort();
  const proc = startProxy({ port, dashboardPort, lockDir: tempDir("lock") });
  assert.equal(await proc.exited, 1);
  assert.match(proc.stderr, /Refusing to run as an unscoped stdio primary/);
});
