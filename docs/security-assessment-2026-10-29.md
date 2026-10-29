# 4Q-Tokenz security assessment, 2026-10-29

Scope: `~/projects/4q-tokens` at commit 38fb5cd plus a dependency update (see Dependencies). Frameworks: OWASP Top 10 2025, GCVE (vulnerability.circl.lu), OSV.dev. Method: dependency audit, OSV batch query of all 115 locked packages, GCVE lookups for the direct dependencies, and a manual review of the network surfaces, upstream spawning, credential handling and logging. This is a point-in-time review by the maintainer's tooling, not an independent test.

## Dependencies (OWASP A03, OSV, GCVE)

| Source | Result |
|--------|--------|
| `pnpm audit` before | 2 high: `zod` < 4.6.6 (memory exhaustion, GHSA-mrhx-c7xc-m3w5), `body-parser` < 2.4.0 (DoS, GHSA-27r3-jxmh-p828, via SDK > express) |
| Fix applied | `zod` 4.6.5 to 4.6.7, `@modelcontextprotocol/sdk` 1.32.1 to 1.32.2, pnpm override `body-parser ^2.4.0` (resolved 2.4.0) |
| `pnpm audit` after | No known vulnerabilities |
| OSV.dev querybatch, 115 packages | No hits |
| GCVE, direct dependencies | Listed CVEs (CVE-2024-45590 body-parser, CVE-2026-6991 zod, CVE-2026-25536 / -111767 / -104850 MCP SDK) all affect versions below what is installed |

Tests: 20 of 20 pass after the update.

## Findings

Severity is for the intended deployment: a loopback service on a single-user host that fronts several semi-trusted agents.

| ID | OWASP 2025 | Severity | Finding | Recommended fix |
|----|------------|----------|---------|-----------------|
| F1 | A01 Broken Access Control, A07 Authentication Failures | High | Lane routes (`/mcp/<agent>`) have no authentication. Any local process can open any lane. The `mcp-session-id` is looked up without checking it belongs to the lane in the URL. | Per-lane bearer tokens, verified in constant time, and bind each session to its lane. |
| F2 | A02 Security Misconfiguration | High | Stdio upstreams are spawned with `{ ...process.env, ...config.env }`. Every upstream receives every secret the proxy started with (MailerLite, Wave, TTS, Nextcloud and the ghl-clark bearer), regardless of lane. A compromised or buggy upstream can read secrets meant for other lanes. | Spawn upstreams with a minimal environment (PATH, HOME, locale) plus the upstream's own `env`. Add an explicit per-upstream `inheritEnv` list for variables an upstream really needs. |
| F3 | A09 Logging and Alerting Failures | Medium | Audit entries carry tool, provider, args and timing, but not the agent or lane. Calls cannot be attributed to an agent. Args are held in memory (last 1000) and not redacted. | Add agent id to audit entries and log lines. Redact or hash args on the dashboard. |
| F4 | A02, A10 Mishandling of Exceptional Conditions | Low | HTTP upstream auth: `process.env[name] || name` falls back to using the config value itself as the bearer token when the variable is unset. It fails open into a wrong credential, not closed. | Fail startup of that upstream if the variable is unset. |
| F5 | A10 | Low | The HTTP error handler returns the raw exception message to the client. | Return a generic message, log the detail. |
| F6 | A06 Insecure Design | Low | Sessions are not capped and have no idle expiry (`httpTransports`). A local process can create many. | Cap sessions per lane and expire idle ones. |
| F7 | A02 | Info | The dashboard (`/api/status`, metrics) is unauthenticated. It is loopback-only with a Host and Origin guard against DNS rebinding, so the exposure is local tool names and status. | Acceptable. Revisit if bound beyond loopback. |

Controls confirmed in place: loopback-only listeners, Host and Origin guard (DNS rebinding), fail-closed unscoped route (403), deny lists with unmatched-deny warnings, no `eval` or shell execution in source, secrets not logged by the proxy, lockfile committed.

## Out of scope but relevant

- OpenClaw plugins `deepseek` and `tavily` are not version-pinned (A03 supply chain). Tracked by the operator.
- Per-agent Docker sandboxes and 1Password vault separation are enforced outside this repository.

## Release gate

F1 and F2 should land before 1.23.0 is published. F3 to F6 are small and can ship in the same release. `README.md` still says "Unreleased (next: v1.23.0)".
