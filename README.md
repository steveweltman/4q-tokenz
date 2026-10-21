# MCP Proxy Gateway

A context-aware MCP proxy that reduces token usage by exposing only 3 tools (`mcp_search`, `mcp_call`, `mcp_schema`) to LLMs instead of the full catalog.

## Why This Exists

When you connect multiple MCP servers to an LLM, every tool from every server is listed in the LLM's context window. For a typical workspace with 50-100 tools across multiple MCP servers, that's thousands of tokens of schema documentation on every request.

MCP Proxy Gateway sits between your LLM and your MCP servers, offering:

- **JIT tool loading** — tools from upstream servers are discovered once at startup, then tools are called on-demand. Clients never see the full catalog.
- **Intelligent search** — fast lexical (BM25) search to find the right tool for a query. Tool tokens are pre-computed at startup for zero-overhead per-query scoring.
- **Token savings** — LLMs only see 3 tool schemas (search, call, schema) instead of 50+. Typical savings: 20-40% per turn for tool-heavy workflows.
- **Zero native dependencies** — pure JavaScript, no native modules, no model downloads, no supply chain risk from ML packages.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your LLM                                │
│   (sees only: mcp_search, mcp_call, mcp_schema)                │
└────────────────────┬────────────────────────────────────────────┘
                     │
         ┌───────────▼──────────────┐
         │   MCP Proxy Gateway      │
         │ ┌──────────────────────┐ │
         │ │ Tool Registry        │ │
         │ │ (BM25 lexical)       │ │
         │ └──────────────────────┘ │
         │ ┌──────────────────────┐ │
         │ │ Connector Manager    │ │
         │ │ (Idle timeout reap)  │ │
         │ └──────────────────────┘ │
         └────────────┬─────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │Google   │  │MailerLite│ │Your Svc │
   │Gmail    │  │ Campaigns│ │ Custom  │
   │Calendar │  │          │ │ Tools   │
   │Drive    │  │          │ │         │
   └─────────┘  └─────────┘  └─────────┘
```

## Prerequisites

- Node.js 18+ with npm or pnpm
- One or more MCP servers to proxy (stdio or HTTP)

## Installation

### From Source

```bash
git clone https://github.com/steveweltman/4q-tokenz.git
cd 4q-tokenz

pnpm install
pnpm build

# Install to ~/.local/bin and configure
./install.sh
```

### As a Dependency

```bash
npm install -g 4q-tokenz
```

## Getting Started: Google Workspace Example

Here's a concrete walkthrough to connect Google Workspace (Gmail, Calendar, Drive) to your LLM through the proxy:

### Step 1: Choose or Build an MCP Server for Google

You need an MCP server that wraps Google APIs. Options:

- **@antidrift/mcp-google** (recommended) — A collection of MCP server implementations for Google Workspace (Gmail, Calendar, Drive, Docs, Sheets). Works out of the box with this proxy.
  ```bash
  npm install @antidrift/mcp-google
  # or
  npx @antidrift/mcp-google --help
  ```

- **@modelcontextprotocol/server-gmail** — Gmail-only, official MCP server
- **Build your own** — See the [MCP spec](https://modelcontextprotocol.io/) to wrap your own APIs

### Step 2: Set Up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable these APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
4. Create an OAuth 2.0 credential (type: Desktop application)
5. Download the credential JSON
6. Run the Google MCP server once to generate `token.json`:
   ```bash
   GOOGLE_CREDENTIAL_FILE=~/Downloads/credentials.json \
   npx @antidrift/mcp-google
   ```
   This opens a browser for you to authorize. Once done, it saves `token.json` locally.

### Step 3: Configure the Proxy

Create `~/.config/4q-tokens/config.json`:

```json
{
  "upstreams": [
    {
      "name": "google-workspace",
      "transport": "stdio",
      "command": "npx",
      "args": ["@antidrift/mcp-google"],
      "env": {
        "GOOGLE_TOKEN_FILE": "~/.local/share/google-mcp/token.json",
        "GOOGLE_CONNECTORS": "gmail,calendar,drive"
      }
    }
  ],
  "searchLimit": 5,
  "callItemLimit": 30,
  "maxTextLength": 800,
  "maxOutputTokens": 10000,
  "idleTimeoutMs": 600000
}
```

### Step 4: Start the Proxy

```bash
mcp-proxy
# Or via systemd if installed:
systemctl --user start mcp-proxy
```

### Step 5: Connect Your LLM

Configure your LLM to use `http://127.0.0.1:9200/mcp` as its MCP server. It will see:
- `mcp_search` — find tools by natural language
- `mcp_call` — invoke a tool
- `mcp_schema` — see tool details

Example query:
```
mcp_search("send an email")
# Returns: google_send_email (Gmail)

mcp_call(ref="google_send_email", args={"to": "user@example.com", "subject": "Hello", "body": "Test"})
```

## Configuration

### Quick Start with Environment Variables

```bash
export MCP_PROXY_UPSTREAMS='[
  {
    "name": "google",
    "transport": "stdio",
    "command": "node",
    "args": ["/path/to/google/server.mjs"],
    "env": {
      "GOOGLE_TOKEN_FILE": "token.json"
    }
  }
]'

export MCP_PROXY_SINGLETON_PORT=9200
export MCP_PROXY_DASHBOARD_PORT=9100

node dist/index.js
```

### Config File (Recommended)

Create `~/.config/4q-tokens/config.json`:

```json
{
  "upstreams": [
    {
      "name": "google-workspace",
      "transport": "stdio",
      "command": "npx",
      "args": ["@antidrift/mcp-google"],
      "env": {
        "GOOGLE_TOKEN_FILE": "token.json",
        "GOOGLE_CONNECTORS": "gmail,calendar,drive"
      }
    },
    {
      "name": "external-api",
      "transport": "http",
      "url": "https://mcp.example.com/",
      "auth": {
        "apiKey": "MY_API_KEY_ENV_VAR"
      }
    }
  ],
  "searchLimit": 3,
  "callItemLimit": 20,
  "maxTextLength": 500,
  "maxOutputTokens": 8000,
  "idleTimeoutMs": 300000
}
```

Then run:

```bash
node dist/index.js
```

The proxy will load the config from `~/.config/4q-tokens/config.json` if it exists, otherwise fall back to the `MCP_PROXY_UPSTREAMS` environment variable.

### Configuration Reference

#### Upstream Server Config

```json
{
  "name": "unique-id",
  "transport": "stdio" | "http",
  
  // For stdio transport:
  "command": "node",
  "args": ["path/to/server.mjs"],
  "cwd": "/working/dir",  // optional
  "env": { "KEY": "value" },  // optional
  
  // For http transport:
  "url": "https://example.com/mcp",
  "auth": {
    "apiKey": "ENV_VAR_NAME"  // reads from process.env[ENV_VAR_NAME]
  }
}
```

#### Proxy Options

| Option | Default | Description |
|--------|---------|-------------|
| `searchLimit` | 3 | Max tools returned by mcp_search |
| `callItemLimit` | 20 | Max items in mcp_call response |
| `maxTextLength` | 500 | Truncate text fields to N chars (detail=false: 500, detail=true: 1500) |
| `maxOutputTokens` | 8000 | Hard cap on response size |
| `idleTimeoutMs` | 300000 | Disconnect upstream servers after N ms of inactivity (0 = disabled) |

Environment variable overrides:

```bash
export MCP_PROXY_SEARCH_LIMIT=5
export MCP_PROXY_CALL_ITEM_LIMIT=30
export MCP_PROXY_MAX_TEXT_LENGTH=800
export MCP_PROXY_MAX_OUTPUT_TOKENS=10000
export MCP_PROXY_IDLE_TIMEOUT_MS=600000
```

## Multi-Agent Lanes (Per-Agent Isolation)

When several agents share one proxy, each agent should only be able to see and call its own tools. 4Q-Tokenz does this with **lanes**. A lane is a named view of the tool registry that is served at its own URL, `/mcp/<agentId>`. An agent connected to its lane cannot discover or call tools from any other lane, even if it knows the ref.

```
agent hope    -> entry "tokens-hope"   -> /mcp/hope    -> google-hope, hope-memory
agent clark   -> entry "tokens-clark"  -> /mcp/clark   -> google-clark, clark-memory
(no lane)     -> /mcp                  -> refused (HTTP 403)
```

### Defining lanes

Add an `agents` block next to `upstreams` in `~/.config/4q-tokens/config.json` (or set `MCP_PROXY_AGENTS` as JSON). Each lane lists the upstream **providers** it may use and, optionally, individual tools to **deny**:

```json
{
  "upstreams": [ ... ],
  "agents": {
    "hope": {
      "allow": ["google-hope", "hope-memory"],
      "deny": ["google-hope.drive_share", "google-hope.share_doc"]
    },
    "clark": { "allow": ["google-clark", "clark-memory"] }
  }
}
```

| Field | Description |
|-------|-------------|
| `allow` | Upstream provider names this lane may use (required, at least one) |
| `deny` | Optional. `provider.tool` or `*.tool` entries removed from the lane after `allow` is applied. Deny always wins. A deny entry that matches no tool logs a warning at startup, so typos do not fail open silently |

Agent ids must match `^[a-z0-9_][a-z0-9_-]{0,63}$`. The plain array form (`"hope": ["google-hope"]`) is still accepted and means allow-only.

### Fail-closed behavior

- The unscoped route `/mcp` is **refused with 403**. A client that is not bound to a lane never sees the whole tool pool. For local development only, set `MCP_PROXY_ALLOW_UNSCOPED=1` to re-enable it.
- An unknown lane (`/mcp/nobody`) returns 404.
- A stdio instance that would become the primary (and so serve the whole pool to one client) refuses to start unless `MCP_PROXY_ALLOW_UNSCOPED=1`. Run the proxy as a service instead (see Singleton and Bridge Mode).
- A bridge refuses to start without a valid `MCP_PROXY_AGENT`.

### Singleton and Bridge Mode

One **primary** instance owns the upstream connections and listens on `MCP_PROXY_SINGLETON_PORT` (default 9200). Run it as a service with `MCP_PROXY_SERVICE_MODE=1` (HTTP only, no stdio). Any additional instance launched as a stdio MCP server detects the live primary through the lock file and becomes a **bridge**. A bridge forwards the client's stdio traffic to the primary on its own lane:

```bash
MCP_PROXY_AGENT=hope node dist/index.js    # bridge: forwards to http://127.0.0.1:9200/mcp/hope
```

The lock file lives in `MCP_PROXY_LOCK_DIR`, else `$XDG_RUNTIME_DIR`, else `/run/user/<uid>`, else the temp dir. Hosts that launch the proxy with a minimal environment (for example the OpenClaw gateway) do not set `XDG_RUNTIME_DIR`, which is why the `/run/user/<uid>` fallback exists. If an instance wins a lock but finds the port already served, it releases the lock and bridges instead of crashing.

### Wiring agents in OpenClaw

OpenClaw has no per-agent MCP setting and does not tell a stdio server which agent launched it. Isolation therefore needs two layers:

1. **One MCP server entry per agent**, each passing its own lane through the environment. Use names that start with a letter, because OpenClaw exposes MCP tools as `<serverName>__<tool>`:

```json
"mcp": {
  "servers": {
    "tokens-hope":  { "command": "/path/to/start-4q-tokens.sh", "env": { "MCP_PROXY_AGENT": "hope" } },
    "tokens-clark": { "command": "/path/to/start-4q-tokens.sh", "env": { "MCP_PROXY_AGENT": "clark" } }
  }
}
```

2. **Each agent denies the other agents' entries** using glob patterns in its tool policy, so it does not see them at all (deny always wins in OpenClaw's tool policy):

```json
"agents": { "entries": { "hope": { "tools": { "deny": ["tokens-clark__*"] } } } }
```

The proxy lane is the enforcing boundary: whatever an agent does, a bridge bound to `hope` can only reach `/mcp/hope`. The OpenClaw deny list is defense in depth that keeps one agent from being handed another agent's entry.

### Verifying isolation

- Proxy log: every session is logged with its lane, for example `HTTP session created: ... [hope]`. There should be no `[open]` sessions and no `Refused unscoped` lines in normal operation.
- From each agent, run `mcp_search` and confirm only that lane's providers appear.
- From an agent, call a ref from another lane. It must return `Tool not found`.

## Running

### Standalone (Stdio Transport)

```bash
node dist/index.js
```

The proxy connects via stdio to your LLM. Use it with Claude or other MCP clients.

### As a Systemd User Service

The install script can set this up for you (see below), or manually:

1. Create `~/.config/systemd/user/mcp-proxy.service`:

```ini
[Unit]
Description=MCP Proxy Gateway
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/mcp-proxy
Restart=on-failure
RestartSec=5s
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin"

[Install]
WantedBy=default.target
```

2. Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable mcp-proxy
systemctl --user start mcp-proxy
```

3. View logs:

```bash
journalctl --user -u mcp-proxy -f
```

### Prometheus Metrics (Port 9100)

The dashboard exposes a Prometheus-compatible `/metrics` endpoint:

```bash
curl http://localhost:9100/metrics
```

Metrics exposed:
| Metric | Type | Description |
|--------|------|-------------|
| `mcp_proxy_uptime_seconds` | gauge | Seconds since process started |
| `mcp_proxy_registered_tools` | gauge | Tools in the registry |
| `mcp_proxy_upstream_up` | gauge | 1 if upstream is connected/idle, 0 if error |
| `mcp_proxy_upstream_tools` | gauge | Tools discovered per upstream |
| `mcp_proxy_calls_total` | counter | Calls by tool, provider, status |
| `mcp_proxy_call_duration_ms_total` | counter | Cumulative call duration (ms) |
| `mcp_proxy_output_bytes_total` | counter | Cumulative output bytes |

Add a scrape job in your Prometheus/Alloy config:

```yaml
scrape_configs:
  - job_name: mcp-proxy
    static_configs:
      - targets: ['localhost:9100']
    metrics_path: /metrics
```

### HTTP Server (Port 9200)

The proxy always starts an HTTP transport on port 9200 by default. Set `MCP_PROXY_SINGLETON_PORT` to use a different port. This allows multiple clients to connect to a single proxy instance. Clients connect to a lane at `/mcp/<agentId>` (see Multi-Agent Lanes). The unscoped `/mcp` route is refused unless `MCP_PROXY_ALLOW_UNSCOPED=1` is set.

```bash
export MCP_PROXY_SINGLETON_PORT=9200
export MCP_PROXY_SERVICE_MODE=1
node dist/index.js &

# From another process, on a lane:
curl -X POST http://127.0.0.1:9200/mcp/hope -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "curl", "version": "1"}}}'
```

## Troubleshooting

### Upstream MCP Server Won't Connect

Check the server logs in the dashboard (port 9100 by default) or daemon logs:

```bash
journalctl --user -u mcp-proxy -e
```

The proxy logs:
- Tool discovery on startup
- Connection failures with error messages
- Upstream stderr (piped from stdio servers)

### Proxy Crashes or Freezes

The proxy has comprehensive error handling to gracefully degrade on upstream failures:

- If an upstream tool call fails, the error is logged and returned to the client
- If all upstreams fail at discovery, startup fails with `NO_UPSTREAMS`

For unhandled errors, check:

```bash
journalctl --user -u mcp-proxy -n 50  # Last 50 lines
```

### Tool Returns No Data

When a tool returns `null` or malformed data, the output shaper handles it gracefully:

- Null results return `[]`
- Strings are wrapped as `{value: string}`
- CSV is auto-parsed if it looks like tabular data
- Raw binary content (images, files) is preserved via `_rawContent`

If a tool response looks truncated, retry with `detail=true` in mcp_call to disable output shaping:

```
mcp_call(ref="google_send_email", args={...}, detail=true)
```

## Security & Networking

The proxy binds to **`127.0.0.1` only** for security — it's not accessible from the network by default. To access remotely:

- **Same machine**: Connect locally on `127.0.0.1:9200`
- **Remote access**: Use Tailscale, SSH forwarding, or a VPN tunnel
  ```bash
  ssh -L 9200:127.0.0.1:9200 user@remote-host
  ```
- **Systemd service**: Access is local by default; no firewall rule needed
- **Tenant isolation**: see Multi-Agent Lanes. Lanes are enforced by the proxy, not by the agents, and the unscoped route fails closed

## Known Limitations

- **Tests are focused, not exhaustive**: `pnpm test` runs regression tests for the singleton lock, bridge startup, lane isolation and deny lists (Node's built-in test runner, no extra dependencies). Upstream connector behavior is not covered
- **Lane enforcement depends on how clients connect**: a bridge or client is only isolated if it is bound to a lane. The proxy refuses unbound clients, but it cannot stop a client you deliberately point at another agent's lane

## Changelog

### Unreleased (next: v1.23.0)
Per-agent isolation is now enforced rather than optional:
- **Breaking:** the unscoped `/mcp` route is refused with 403 unless `MCP_PROXY_ALLOW_UNSCOPED=1`. Clients must use `/mcp/<agentId>`
- **Breaking:** a bridge reads `MCP_PROXY_AGENT`, connects to its lane, and refuses to start without a valid agent id. A non-service stdio primary refuses to start unless `MCP_PROXY_ALLOW_UNSCOPED=1`
- New per-lane `deny` list (`provider.tool` or `*.tool`) in the `agents` config, with a startup warning for entries that match no tool
- README: new Multi-Agent Lanes section covering lane config, fail-closed behavior, singleton and bridge mode, and OpenClaw wiring
- Tests added for lane isolation, fail-closed paths and deny semantics

### v1.22.3
- `@modelcontextprotocol/sdk` 1.31.0 to 1.32.1, clearing all `pnpm audit --prod` findings (including `proxy-addr` via express)

### v1.22.2
- Version bump so the build with the singleton lock fix is distinguishable

### Singleton lock directory fix (between v1.22.1 and v1.22.2)
- Fixed: a proxy launched with a minimal environment (no `XDG_RUNTIME_DIR`, for example by the OpenClaw gateway) looked for its lock in the temp dir, did not find the running primary, tried to become a second primary and crashed with `EADDRINUSE`, which the client saw as `MCP error -32000: Connection closed`. The lock directory now falls back to `/run/user/<uid>`, and an instance that wins a lock but finds the port served bridges instead of crashing
- Added regression tests (`pnpm test`)

### v1.22.1
Security hardening from the pre-release assessment (OWASP Top 10 2025, OSV.dev, GCVE):
- Dashboard: removed `Access-Control-Allow-Origin: *` from `/api/status`, and stopped returning tool-call `args` in the audit log data — previously any website could read recent call arguments from `127.0.0.1:9100`
- New `src/host-guard.ts`: `/mcp` and the dashboard reject requests whose `Host` or `Origin` is not loopback (403), blocking DNS-rebinding and cross-site browser access
- Singleton lock file now lives in `$XDG_RUNTIME_DIR` when set (falls back to the temp dir) and is created with mode 0600
- OSV.dev: 0 advisories across all 93 installed packages; `pnpm audit` clean

### v1.22.0
- Major dependency upgrades: `zod` 3.25 → 4.6, `typescript` 6.0 → 7.0, `@types/node` 25 → 26
- zod 4 migration: `z.record` calls now pass an explicit key schema (`src/types.ts`)
- Bump `@modelcontextprotocol/sdk` from `^1.30.0` to `^1.31.0`
- Tighten pnpm overrides: `hono >=4.13.5`, `fast-uri >=4.1.4`, `ip-address >=10.5.1`; add `qs >=6.16.0` — clears 2 high and 7 moderate advisories (all transitive via the MCP SDK)
- Verified clean against `pnpm audit`

### v1.21.2
- Fix incomplete v1.21.1 patch: the `hono` pnpm override (`>=4.12.25`) still resolved to a vulnerable 4.12.x release; tightened to `>=4.12.34`
- Add pnpm overrides for `@hono/node-server >=1.19.15`, `fast-uri >=3.1.5`, `ip-address >=10.3.1`, `body-parser >=2.3.0` — all transitive via `@modelcontextprotocol/sdk`, resolves 3 high and 6 medium/low CVEs (DoS, ReDoS, SSRF-adjacent parsing bugs)
- Bump `@modelcontextprotocol/sdk` from `^1.26.0` to `^1.30.0`
- Verified clean against `pnpm audit` and OSV.dev for all resolved dependency versions

### v1.21.1
- Attempted hono dependency patch (`pnpm override: hono >=4.12.25`) — override was too loose and did not actually clear the vulnerable range; fully resolved in v1.21.2 above

### v1.21.0
- `detail=true` no longer truncates text fields in tool output

### v1.20.0
- Per-agent lane isolation: URL routing at `/mcp/{agentId}`, filtered tool registry views, `MCP_PROXY_AGENTS` config

### v1.19.0
- Add Prometheus `/metrics` endpoint on the dashboard port (9100 by default)
- Exposes: `mcp_proxy_uptime_seconds`, `mcp_proxy_registered_tools`, `mcp_proxy_upstream_up`, `mcp_proxy_upstream_tools`, `mcp_proxy_calls_total`, `mcp_proxy_call_duration_ms_total`, `mcp_proxy_output_bytes_total`
- Counters persist for the lifetime of the process; scrape with Prometheus/Alloy and visualize in Grafana

### v1.18.0
- Drop `@xenova/transformers` entirely — eliminates the protobufjs/ONNX runtime supply chain
- Switch to pure lexical (BM25) search; tool tokens pre-computed at startup, zero per-query overhead
- No change to mcp_search quality for English-language tool catalogs
- Removes ~90MB model download on first run and all native module requirements

### v1.17.1
- Pre-compute tool token sets at registry build time; lexical scoring now reads the cache instead of re-tokenizing on every query
- Add LRU cache for query embeddings (embeddings removed entirely in v1.18.0)

### v1.17.0
- Switch to lighter English-optimized embedding model, reducing cold-start download by ~380MB (embeddings removed entirely in v1.18.0)

### v1.16.0
- Update `@modelcontextprotocol/sdk` from `~1.22.0` to `^1.26.0` — resolves 3 high-severity CVEs: ReDoS, cross-client data leak, DNS rebinding
- Add pnpm override: `protobufjs >=7.5.8` — resolves critical arbitrary code execution and multiple high CVEs in `@xenova/transformers` transitive dependency chain
- Add pnpm override: `qs >=6.15.2` — resolves moderate DoS vulnerability in `express` transitive dependency

## Attribution

MCP Proxy Gateway is a fork of [@arvoretech/mcp-proxy](https://github.com/arvoreeducacao/arvore-mcp-servers), originally created by **João Augusto** and **Árvore Educação**.

Forked and extended with:
- Singleton mode for HTTP bridge
- Idle server reaping
- Comprehensive error handling
- Config file support
- Systemd integration

## License

MIT. See [LICENSE](./LICENSE).
