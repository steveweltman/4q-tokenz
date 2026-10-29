import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tempDir, freePort, startProxy, waitFor, stop, initializeOverStdio, DIST } from "./helpers.mjs";

const { hashToken, verifyLaneToken, extractBearer, createTokenFile, readTokenFile } = await import(`${DIST}/lane-auth.js`);
const { buildUpstreamEnv } = await import(`${DIST}/connector.js`);

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);

test("hashToken/verifyLaneToken accept the right token and nothing else", () => {
  const hash = hashToken(TOKEN_A);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyLaneToken(TOKEN_A, hash), true);
  assert.equal(verifyLaneToken(TOKEN_B, hash), false);
  assert.equal(verifyLaneToken(null, hash), false);
  assert.equal(verifyLaneToken(TOKEN_A, undefined), false);
  assert.equal(verifyLaneToken(TOKEN_A, "sha256:short"), false);
});

test("extractBearer only accepts a well-formed bearer header", () => {
  assert.equal(extractBearer(`Bearer ${TOKEN_A}`), TOKEN_A);
  assert.equal(extractBearer("Basic abc"), null);
  assert.equal(extractBearer("Bearer short"), null);
  assert.equal(extractBearer(undefined), null);
});

test("token files are created 0600, not overwritten silently, and read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "4q-tok-"));
  const file = join(dir, "alpha");
  const hash = createTokenFile(file, TOKEN_A, false);
  assert.equal(hash, hashToken(TOKEN_A));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readTokenFile(file), TOKEN_A);
  assert.throws(() => createTokenFile(file, TOKEN_B, false), /already exists/);
  createTokenFile(file, TOKEN_B, true);
  assert.equal(readTokenFile(file), TOKEN_B);
  writeFileSync(file, "bad token!\n");
  assert.throws(() => readTokenFile(file), /invalid token/);
  assert.throws(() => readTokenFile(join(dir, "missing")), /could not be read/);
});

test("stdio upstreams get a minimal environment plus only what is listed", () => {
  const source = { PATH: "/bin", HOME: "/h", SECRET_ONE: "x", SECRET_TWO: "y", LANG: "C" };
  const env = buildUpstreamEnv({ env: { OWN: "1" }, inheritEnv: ["SECRET_TWO"] }, source);
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", LANG: "C", SECRET_TWO: "y", OWN: "1" });
  assert.equal("SECRET_ONE" in env, false);
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function tokenProxy(extraEnv = {}) {
  const port = await freePort();
  const dashboardPort = await freePort();
  const primary = startProxy({
    port,
    dashboardPort,
    lockDir: tempDir("lock"),
    service: true,
    extraEnv: {
      MCP_PROXY_AGENTS: JSON.stringify({
        alpha: { allow: ["stub"], tokenHash: hashToken(TOKEN_A) },
        beta: { allow: ["stub"], tokenHash: hashToken(TOKEN_B) },
        open: { allow: ["stub"] },
      }),
      ...extraEnv,
    },
  });
  await waitFor(() => primary.stderr.includes("Agent isolation: ENABLED"), { label: "lanes ready" });
  return { primary, port };
}

const post = (port, lane, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/mcp/${lane}`, { method: "POST", headers: { ...HEADERS, ...headers }, body: JSON.stringify(INIT) });

test("a lane with a token refuses missing and wrong tokens, accepts the right one", async () => {
  const { primary, port } = await tokenProxy();
  try {
    assert.equal((await post(port, "alpha")).status, 401);
    assert.equal((await post(port, "alpha", { Authorization: `Bearer ${TOKEN_B}` })).status, 401);
    assert.equal((await post(port, "alpha", { Authorization: `Bearer ${TOKEN_A}` })).status, 200);
    assert.equal((await post(port, "open")).status, 200);
    assert.match(primary.stderr, /lane \[alpha\] \(token required\)/);
    assert.ok(!primary.stderr.includes(TOKEN_A));
  } finally {
    await stop(primary);
  }
});

test("a session opened on one lane is not usable on another", async () => {
  const { primary, port } = await tokenProxy();
  try {
    const res = await post(port, "open");
    const sessionId = res.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const other = await fetch(`http://127.0.0.1:${port}/mcp/alpha`, {
      method: "POST",
      headers: { ...HEADERS, Authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.notEqual(other.status, 200);
  } finally {
    await stop(primary);
  }
});

test("a real client works end to end with the token and audit lines carry the lane", async () => {
  const { primary, port } = await tokenProxy();
  try {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/alpha`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
      }),
    );
    await client.callTool({ name: "mcp_search", arguments: { query: "ping" } });
    await client.close();
    await waitFor(() => primary.stderr.includes("[audit] [alpha] mcp_search"), { label: "lane-tagged audit line" });
  } finally {
    await stop(primary);
  }
});

test("requireLaneTokens refuses a lane that has no token configured", async () => {
  const { primary, port } = await tokenProxy({ MCP_PROXY_REQUIRE_LANE_TOKENS: "1" });
  try {
    assert.equal((await post(port, "open")).status, 401);
    assert.equal((await post(port, "alpha", { Authorization: `Bearer ${TOKEN_A}` })).status, 200);
    assert.match(primary.stderr, /requireLaneTokens is set but the lane has no tokenHash/);
  } finally {
    await stop(primary);
  }
});

function lanesEnv() {
  return {
    MCP_PROXY_AGENTS: JSON.stringify({ alpha: { allow: ["stub"], tokenHash: hashToken(TOKEN_A) } }),
  };
}

async function tokenPrimary() {
  const port = await freePort();
  const dashboardPort = await freePort();
  const lockDir = tempDir("lock");
  const primary = startProxy({ port, dashboardPort, lockDir, service: true, extraEnv: lanesEnv() });
  await waitFor(() => primary.stderr.includes("Agent isolation: ENABLED"), { label: "lanes ready" });
  return { primary, port, dashboardPort: await freePort(), lockDir };
}

test("a bridge sends its lane token from MCP_PROXY_TOKEN_FILE", async () => {
  const { primary, port, dashboardPort, lockDir } = await tokenPrimary();
  const file = join(mkdtempSync(join(tmpdir(), "4q-tok-")), "alpha");
  createTokenFile(file, TOKEN_A, false);
  const bridge = startProxy({ port, dashboardPort, lockDir, agent: "alpha", extraEnv: { ...lanesEnv(), MCP_PROXY_TOKEN_FILE: file } });
  try {
    await initializeOverStdio(bridge);
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_search", arguments: { query: "ping" } } }) + "\n");
    await waitFor(() => bridge.stdout.includes('"id":2'), { label: "search response" });
    assert.doesNotMatch(bridge.stdout, /Unauthorized/);
    assert.ok(!bridge.stderr.includes(TOKEN_A));
  } finally {
    await stop(bridge);
    await stop(primary);
  }
});

test("a bridge with an unreadable token file refuses to start", async () => {
  const { primary, port, dashboardPort, lockDir } = await tokenPrimary();
  const bridge = startProxy({ port, dashboardPort, lockDir, agent: "alpha", extraEnv: { ...lanesEnv(), MCP_PROXY_TOKEN_FILE: "/nonexistent/token" } });
  try {
    assert.equal(await bridge.exited, 1);
    assert.match(bridge.stderr, /lane token file could not be read/);
  } finally {
    await stop(primary);
  }
});

test("a bridge without a token cannot use a token-protected lane", async () => {
  const { primary, port, dashboardPort, lockDir } = await tokenPrimary();
  const bridge = startProxy({ port, dashboardPort, lockDir, agent: "alpha", extraEnv: lanesEnv() });
  try {
    await initializeOverStdio(bridge);
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_search", arguments: { query: "ping" } } }) + "\n");
    await waitFor(() => bridge.stdout.includes('"id":2'), { timeoutMs: 30000, label: "error response" });
    const line = bridge.stdout.split("\n").find((l) => l.includes('"id":2'));
    assert.match(line, /isError|error/i);
  } finally {
    await stop(bridge);
    await stop(primary);
  }
});
