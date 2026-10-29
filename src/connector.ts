import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolRegistry } from "./registry.js";
import {
  ProxyError,
  type UpstreamServerConfig,
  type UpstreamStatus,
} from "./types.js";

interface ConnectedUpstream {
  config: UpstreamServerConfig;
  client: Client;
}

const MAX_LOGS = 100;
const IDLE_CHECK_INTERVAL_MS = 60_000;

// Variables every stdio upstream gets. Everything else must be listed in the
// upstream's own "env" (values) or "inheritEnv" (names copied from the proxy).
const BASE_ENV_NAMES = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR"];

export function buildUpstreamEnv(
  config: Pick<UpstreamServerConfig, "env" | "inheritEnv">,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV_NAMES, ...config.inheritEnv]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...config.env };
}

export class McpConnectorManager {
  private readonly upstreams = new Map<string, ConnectedUpstream>();
  private readonly configs = new Map<string, UpstreamServerConfig>();
  private readonly statuses = new Map<string, UpstreamStatus>();
  private readonly activating = new Map<string, Promise<void>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimeoutMs = 5 * 60 * 1000;

  constructor(private readonly registry: ToolRegistry) { }

  private addLog(name: string, msg: string): void {
    const s = this.statuses.get(name);
    if (!s) return;
    s.logs.push(`[${new Date().toISOString()}] ${msg}`);
    if (s.logs.length > MAX_LOGS) s.logs = s.logs.slice(-MAX_LOGS);
  }

  getStatuses(): UpstreamStatus[] {
    return Array.from(this.statuses.values());
  }

  async discoverAll(configs: UpstreamServerConfig[]): Promise<void> {
    let discovered = 0;

    for (const config of configs) {
      this.configs.set(config.name, config);
      this.statuses.set(config.name, {
        name: config.name,
        transport: config.transport,
        status: "connecting",
        toolCount: 0,
        logs: [],
      });
      this.addLog(config.name, `Discovering tools via ${config.transport}...`);

      try {
        if (config.transport === "http") {
          await this.connectHttp(config);
        } else {
          await this.connectStdio(config);
        }

        const client = this.upstreams.get(config.name)!.client;
        await this.ingestTools(config.name, client);

        const toolCount = this.registry.getByProvider(config.name).length;
        const s = this.statuses.get(config.name)!;
        s.toolCount = toolCount;
        s.status = "idle";
        this.addLog(config.name, `Discovered ${toolCount} tools, going idle`);
        console.error(`[connector] ${config.name} — ${toolCount} tools (idle)`);

        await this.disconnectOne(config.name);
        discovered++;
      } catch (error) {
        const s = this.statuses.get(config.name)!;
        s.status = "error";
        const exMsg = error instanceof Error ? error.message : String(error);
        this.addLog(config.name, `ERROR: ${exMsg}`);
        if (error instanceof Error && error.stack) {
          this.addLog(config.name, error.stack);
        }
        const stderrLines = s.logs
          .map((l) => l.replace(/^\[.*?\]\s*/, ""))
          .filter((l) => l !== `Discovering tools via ${config.transport}...`);
        s.error = stderrLines.length > 0 ? stderrLines.join("\n") : exMsg;
        console.error(
          `[connector] Failed discovery for ${config.name}:`,
          exMsg,
        );
      }
    }

    if (discovered === 0) {
      throw new ProxyError("No upstreams discovered", "NO_UPSTREAMS");
    }
  }

  async ensureConnected(provider: string): Promise<void> {
    if (this.upstreams.has(provider)) {
      const s = this.statuses.get(provider);
      if (s) s.lastUsedAt = Date.now();
      return;
    }

    const inflight = this.activating.get(provider);
    if (inflight) return inflight;

    const config = this.configs.get(provider);
    if (!config) {
      throw new ProxyError(
        `Unknown provider: ${provider}`,
        "PROVIDER_NOT_FOUND",
      );
    }

    const activation = this.activate(config);
    this.activating.set(provider, activation);

    try {
      await activation;
    } finally {
      this.activating.delete(provider);
    }
  }

  private async activate(config: UpstreamServerConfig): Promise<void> {
    const s = this.statuses.get(config.name);
    if (s) {
      s.status = "activating";
      s.error = undefined;
    }
    this.addLog(config.name, `Activating via ${config.transport}...`);
    console.error(`[connector] Activating ${config.name}...`);

    try {
      if (config.transport === "http") {
        await this.connectHttp(config);
      } else {
        await this.connectStdio(config);
      }

      if (s) {
        s.status = "connected";
        s.lastUsedAt = Date.now();
      }
      this.addLog(config.name, "Activated");
      console.error(`[connector] ${config.name} activated`);
    } catch (error) {
      if (s) {
        s.status = "error";
        const exMsg = error instanceof Error ? error.message : String(error);
        s.error = exMsg;
        this.addLog(config.name, `Activation failed: ${exMsg}`);
      }
      throw new ProxyError(
        `Failed to activate: ${config.name}`,
        "UPSTREAM_CONNECTION_FAILED",
      );
    }
  }

  async callTool(
    provider: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      await this.ensureConnected(provider);

      const upstream = this.upstreams.get(provider);
      if (!upstream)
        throw new ProxyError(
          `Provider not connected: ${provider}`,
          "PROVIDER_NOT_FOUND",
        );

      const s = this.statuses.get(provider);
      if (s) s.lastUsedAt = Date.now();

      const result = await upstream.client.callTool({
        name: toolName,
        arguments: args,
      });

      if (result.content && Array.isArray(result.content)) {
        const hasNonText = result.content.some(
          (c: { type: string }) => c.type !== "text",
        );
        if (hasNonText) {
          return { _rawContent: result.content };
        }

        const textParts = result.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text);
        if (textParts.length === 1) {
          try {
            return JSON.parse(textParts[0]);
          } catch {
            return textParts[0];
          }
        }
        return textParts.join("\n");
      }
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[connector] Failed to call tool ${toolName} on ${provider}: ${msg}`
      );
      throw error;
    }
  }

  startIdleReaper(timeoutMs: number): void {
    this.idleTimeoutMs = timeoutMs;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (timeoutMs <= 0) return;

    this.idleTimer = setInterval(() => this.reapIdle(), IDLE_CHECK_INTERVAL_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stopIdleReaper(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const [name, upstream] of this.upstreams) {
      const s = this.statuses.get(name);
      if (!s || !s.lastUsedAt) continue;
      if (now - s.lastUsedAt < this.idleTimeoutMs) continue;

      console.error(
        `[connector] Reaping idle provider: ${name} (idle ${Math.round((now - s.lastUsedAt) / 1000)}s)`,
      );
      try {
        await upstream.client.close();
      } catch (e) {
        console.error(
          `[connector] Error closing ${name}:`,
          e instanceof Error ? e.message : e,
        );
      }
      this.upstreams.delete(name);
      s.status = "idle";
      this.addLog(name, "Disconnected (idle timeout)");
    }
  }

  private async connectStdio(config: UpstreamServerConfig): Promise<void> {
    if (!config.command)
      throw new ProxyError(
        `${config.name}: stdio needs "command"`,
        "INVALID_CONFIG",
      );
    const client = new Client({
      name: `mcp-proxy-${config.name}`,
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: buildUpstreamEnv(config),
      cwd: config.cwd || process.cwd(),
      stderr: "pipe",
    });
    this.pipeStderr(config.name, transport);
    await client.connect(transport);
    this.upstreams.set(config.name, { config, client });
  }

  private pipeStderr(name: string, transport: StdioClientTransport): void {
    const stream = transport.stderr as unknown as Readable | null;
    if (!stream || typeof stream.on !== "function") return;
    let buf = "";
    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line) {
          this.addLog(name, line);
          console.error(`[${name}] ${line}`);
        }
      }
    });
    stream.on("end", () => {
      if (buf.trim()) {
        this.addLog(name, buf.trim());
        console.error(`[${name}] ${buf.trim()}`);
      }
    });
  }

  private async connectHttp(config: UpstreamServerConfig): Promise<void> {
    if (!config.url)
      throw new ProxyError(
        `${config.name}: http needs "url"`,
        "INVALID_CONFIG",
      );
    const baseUrl = new URL(config.url);

    // auth.apiKey names an environment variable. Fail closed if it is unset,
    // never send the variable's name (or any other literal) as the credential.
    let token: string | undefined;
    if (config.auth?.apiKey) {
      token = process.env[config.auth.apiKey];
      if (!token) {
        throw new ProxyError(
          `${config.name}: environment variable ${config.auth.apiKey} is not set`,
          "INVALID_CONFIG",
        );
      }
    }

    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const requestInit = { headers };
    const client = new Client({
      name: `mcp-proxy-${config.name}`,
      version: "1.0.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit,
      });
      await client.connect(transport);
      this.upstreams.set(config.name, { config, client });
    } catch (streamableErr) {
      const sseUrl = new URL(config.url);
      const hasSsePath = sseUrl.pathname.endsWith("/sse") || sseUrl.pathname.endsWith("/events");

      if (!hasSsePath) {
        throw streamableErr;
      }

      console.error(
        `[connector] StreamableHTTP failed for ${config.name}, trying SSE (URL has SSE path)...`,
      );
      const sseClient = new Client({
        name: `mcp-proxy-${config.name}`,
        version: "1.0.0",
      });
      const sseTransport = new SSEClientTransport(sseUrl, { requestInit });
      await sseClient.connect(sseTransport);
      this.upstreams.set(config.name, { config, client: sseClient });
    }
  }

  private async disconnectOne(name: string): Promise<void> {
    const upstream = this.upstreams.get(name);
    if (!upstream) return;
    try {
      await upstream.client.close();
    } catch (e) {
      console.error(
        `[connector] Error disconnecting ${name}:`,
        e instanceof Error ? e.message : e,
      );
    }
    this.upstreams.delete(name);
  }

  async disconnectAll(): Promise<void> {
    for (const [name, upstream] of this.upstreams) {
      try {
        await upstream.client.close();
      } catch (e) {
        console.error(
          `[connector] Error disconnecting ${name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    this.upstreams.clear();
  }

  async refreshTools(): Promise<void> {
    this.registry.clear();
    for (const [name, upstream] of this.upstreams) {
      await this.ingestTools(name, upstream.client);
    }
  }

  private async ingestTools(provider: string, client: Client): Promise<void> {
    try {
      let cursor: string | undefined;
      let previousCursor: string | undefined;
      do {
        try {
          const response = await client.listTools({ cursor });
          if (!response) {
            console.error(
              `[connector] Null response from listTools(${provider})`,
            );
            break;
          }
          if (!Array.isArray(response.tools)) {
            console.error(
              `[connector] Invalid response from ${provider}: missing tools array`,
            );
            break;
          }

          for (const tool of response.tools) {
            try {
              if (!tool.name) {
                console.error(
                  `[connector] Skipping tool without name from ${provider}`,
                );
                continue;
              }
              await this.registry.ingestUpstreamTool(
                provider,
                tool.name,
                tool.description || "",
                (tool.inputSchema as Record<string, unknown>) || {},
              );
            } catch (error) {
              console.error(
                `[connector] Failed to ingest tool ${tool.name} from ${provider}:`,
                error instanceof Error ? error.message : error,
              );
            }
          }
          if (response.nextCursor && response.nextCursor === cursor) break;
          previousCursor = cursor;
          cursor = response.nextCursor;
          if (cursor && cursor === previousCursor) break;
        } catch (error) {
          console.error(
            `[connector] Error listing tools from ${provider}:`,
            error instanceof Error ? error.message : error,
          );
          break;
        }
      } while (cursor);
    } catch (error) {
      console.error(
        `[connector] Ingest failed for ${provider}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  get connectedProviders(): string[] {
    return Array.from(this.upstreams.keys());
  }

  get discoveredProviders(): string[] {
    return Array.from(this.configs.keys());
  }
}
