import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpConnectorManager } from "./connector.js";
import { Dashboard } from "./dashboard.js";
import { AuditLogger } from "./logger.js";
import { OutputShaper } from "./output-shaper.js";
import { PaginationManager } from "./pagination.js";
import { ToolRegistry } from "./registry.js";
import { HybridSearch } from "./search.js";
import { SessionMemory } from "./session-memory.js";
import {
  AgentConfigSchema,
  type CallParams,
  CallParamsSchema,
  type McpToolResult,
  type ProxyConfig,
  ProxyConfigSchema,
  ProxyError,
  SchemaParamsSchema,
  type SearchParams,
  SearchParamsSchema,
  UpstreamServerConfigSchema,
} from "./types.js";

export class McpProxyServer {
  private readonly server: McpServer;
  private readonly registry: ToolRegistry;
  private readonly connector: McpConnectorManager;
  private readonly search: HybridSearch;
  private readonly sessionMemory: SessionMemory;
  private readonly shaper: OutputShaper;
  private readonly pagination: PaginationManager;
  private readonly logger: AuditLogger;
  private readonly dashboard: Dashboard;
  private readonly config: ProxyConfig;
  private upstreamsReady: Promise<void> = Promise.resolve();
  private agentViews = new Map<string, { registry: ToolRegistry; search: HybridSearch }>();
  private httpServer: HttpServer | null = null;
  private httpTransports = new Map<string, StreamableHTTPServerTransport>();

  constructor(config: ProxyConfig) {
    this.config = config;
    this.server = new McpServer({
      name: "mcp-proxy-gateway",
      version: "1.0.0",
    });

    this.sessionMemory = new SessionMemory();
    this.registry = new ToolRegistry();
    this.connector = new McpConnectorManager(this.registry);
    this.search = new HybridSearch(this.registry, this.sessionMemory);
    this.shaper = new OutputShaper(config.callItemLimit, config.maxTextLength);
    this.pagination = new PaginationManager();
    this.logger = new AuditLogger();
    this.dashboard = new Dashboard(
      this.connector,
      this.registry,
      this.logger,
      parseInt(process.env.MCP_PROXY_DASHBOARD_PORT || "9100", 10),
    );

    this.registerToolsOn(this.server);
  }

  static fromEnvironment(): McpProxyServer {
    let upstreamsRaw = process.env.MCP_PROXY_UPSTREAMS;
    let agentsRaw = process.env.MCP_PROXY_AGENTS;
    let configSource = "environment";

    if (!upstreamsRaw) {
      const configPath = process.env.MCP_PROXY_CONFIG || join(homedir(), ".config/4q-tokens/config.json");
      if (existsSync(configPath)) {
        try {
          const configContent = readFileSync(configPath, "utf-8");
          const fileConfig = JSON.parse(configContent);
          if (fileConfig.upstreams) {
            upstreamsRaw = JSON.stringify(fileConfig.upstreams);
            configSource = `file:${configPath}`;
            console.error(`[proxy] Loaded upstreams from ${configPath}`);
          }
          if (fileConfig.agents && !agentsRaw) {
            agentsRaw = JSON.stringify(fileConfig.agents);
          }
        } catch (error) {
          console.error(
            `[proxy] Failed to load config file ${configPath}: ${error instanceof Error ? error.message : error}`
          );
        }
      }
    }

    if (!upstreamsRaw) {
      throw new ProxyError(
        "MCP_PROXY_UPSTREAMS environment variable or ~/.config/4q-tokens/config.json is required",
        "MISSING_CONFIG",
      );
    }

    const expanded = upstreamsRaw.replace(
      /\$\{(\w+)\}/g,
      (_, key) => process.env[key] || "",
    );

    let upstreams;
    try {
      const parsed = JSON.parse(expanded);
      upstreams = Array.isArray(parsed)
        ? parsed.map((u: unknown) => UpstreamServerConfigSchema.parse(u))
        : [UpstreamServerConfigSchema.parse(parsed)];
    } catch (error) {
      throw new ProxyError(
        `Invalid upstreams config (${configSource}): ${error instanceof Error ? error.message : error}`,
        "INVALID_CONFIG",
      );
    }

    let agents: Record<string, { allow: string[] }> | undefined;
    if (agentsRaw) {
      try {
        const parsed = JSON.parse(agentsRaw) as Record<string, unknown>;
        agents = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [
            k,
            AgentConfigSchema.parse(Array.isArray(v) ? { allow: v } : v),
          ])
        );
      } catch (error) {
        throw new ProxyError(
          `Invalid agents config: ${error instanceof Error ? error.message : error}`,
          "INVALID_CONFIG",
        );
      }
    }

    const config = ProxyConfigSchema.parse({
      upstreams,
      agents,
      searchLimit: parseInt(process.env.MCP_PROXY_SEARCH_LIMIT || "3", 10),
      callItemLimit: parseInt(
        process.env.MCP_PROXY_CALL_ITEM_LIMIT || "20",
        10,
      ),
      maxTextLength: parseInt(
        process.env.MCP_PROXY_MAX_TEXT_LENGTH || "500",
        10,
      ),
      maxOutputTokens: parseInt(
        process.env.MCP_PROXY_MAX_OUTPUT_TOKENS || "8000",
        10,
      ),
      idleTimeoutMs: parseInt(
        process.env.MCP_PROXY_IDLE_TIMEOUT_MS || String(5 * 60 * 1000),
        10,
      ),
    });

    return new McpProxyServer(config);
  }

  private registerToolsOn(
    server: McpServer,
    registry: ToolRegistry = this.registry,
    search: HybridSearch = this.search,
  ): void {
    server.registerTool(
      "mcp_search",
      {
        title: "Search MCP Tools",
        description:
          "Discover available tools across all connected MCP servers. Returns a short list of relevant tools with refs and usage hints. Use this before mcp_call to find the right tool.",
        inputSchema: {
          query: SearchParamsSchema.shape.query,
          limit: SearchParamsSchema.shape.limit,
        },
      },
      async (params) => this.handleSearch(params as SearchParams, search),
    );

    server.registerTool(
      "mcp_call",
      {
        title: "Call MCP Tool",
        description: [
          "Execute a tool on an upstream MCP server. Use the ref from mcp_search results. Returns normalized, token-efficient output with pagination support.",
          "",
          "IMPORTANT — Output shaping behavior:",
          "• By default (detail=false), the proxy STRIPS metadata fields (id, url, created_at, updated_at, etc.), TRUNCATES text fields to 500 chars, and LIMITS arrays to 5 items. This saves tokens but may hide important data.",
          "• When detail=true, ALL fields are preserved (nothing is stripped), text is returned in full (no per-field truncation — only the overall token budget applies), and arrays are returned in full. Use this when reading documents, long messages, or when default output seems incomplete.",
          "",
          "Rule of thumb: if the default call returns fewer items or less data than expected, retry with detail=true.",
        ].join("\n"),
        inputSchema: {
          ref: CallParamsSchema.shape.ref,
          args: CallParamsSchema.shape.args,
          page_cursor: CallParamsSchema.shape.page_cursor,
          detail: CallParamsSchema.shape.detail,
        },
      },
      async (params) => this.handleCall(params as CallParams, registry),
    );

    server.registerTool(
      "mcp_schema",
      {
        title: "Get Tool Schema",
        description:
          "Get the full input schema for a tool. Use the ref from mcp_search results to see all parameters, types, and required fields before calling mcp_call.",
        inputSchema: {
          ref: SchemaParamsSchema.shape.ref,
        },
      },
      async (params) => this.handleSchema(params as { ref: string }, registry),
    );
  }

  private buildAgentViews(): void {
    if (!this.config.agents) return;
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      const allowed = new Set(agentConfig.allow);
      const filteredRegistry = this.registry.forProviders(allowed);
      const filteredSearch = new HybridSearch(filteredRegistry, this.sessionMemory);
      this.agentViews.set(agentId, { registry: filteredRegistry, search: filteredSearch });
      console.error(
        `[proxy] Agent lane [${agentId}]: ${filteredRegistry.size} tools (${agentConfig.allow.join(', ')})`
      );
    }
  }

  private async handleSchema(
    params: { ref: string },
    registry: ToolRegistry = this.registry,
  ): Promise<McpToolResult> {
    await this.upstreamsReady;
    const entry = registry.get(params.ref);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Tool not found: ${params.ref}. Use mcp_search to discover available tools.`,
            }),
          },
        ],
      };
    }

    const schema = entry._inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    const properties = schema.properties || {};
    const required = new Set(schema.required || []);

    const lines: string[] = [
      `ref = "${entry.ref}"`,
      `title = "${entry.title}"`,
      `description = "${this.escapeToml(entry.description)}"`,
      "",
    ];

    for (const [name, def] of Object.entries(properties)) {
      const prop = def as {
        type?: string;
        description?: string;
        default?: unknown;
        enum?: unknown[];
      };
      const req = required.has(name) ? "required" : "optional";
      const type = prop.type || "unknown";
      lines.push(`[params.${name}]`);
      lines.push(`type = "${type}"`);
      lines.push(`status = "${req}"`);
      if (prop.description) {
        lines.push(
          `desc = "${this.escapeToml(this.truncateText(prop.description, 80))}"`,
        );
      }
      if (prop.default !== undefined) {
        lines.push(`default = ${JSON.stringify(prop.default)}`);
      }
      if (prop.enum) {
        lines.push(`enum = ${JSON.stringify(prop.enum)}`);
      }
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  private async handleSearch(
    params: SearchParams,
    search: HybridSearch = this.search,
  ): Promise<McpToolResult> {
    await this.upstreamsReady;
    const audit = this.logger.createEntry({
      tool: "mcp_search",
      provider: "*",
      args: params as unknown as Record<string, unknown>,
    });

    try {
      const limit = params.limit || this.config.searchLimit;
      const results = search.search(params.query, limit);

      const output = results
        .map(
          (r) =>
            `[[results]]\nref = "${r.ref}"\ntitle = "${r.title}"\nhint = "${this.escapeToml(r.hint)}"`,
        )
        .join("\n\n");
      this.logger.finalize(audit, {
        outputSize: output.length,
        itemCount: results.length,
      });

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.logger.finalize(audit, { outputSize: 0, error: msg });
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  private async handleCall(
    params: CallParams,
    registry: ToolRegistry = this.registry,
  ): Promise<McpToolResult> {
    await this.upstreamsReady;
    if (params.page_cursor) {
      return this.handlePaginatedCall(params);
    }

    const entry = registry.get(params.ref);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Tool not found: ${params.ref}. Use mcp_search to discover available tools.`,
            }),
          },
        ],
      };
    }

    const audit = this.logger.createEntry({
      tool: "mcp_call",
      provider: entry.provider,
      args: params.args,
    });

    try {
      const rawResult = await this.connector.callTool(
        entry.provider,
        entry.originalName,
        params.args,
      );

      if (rawResult && typeof rawResult === "object") {
        const maybeRaw = (rawResult as Record<string, unknown>)["_rawContent"];
        const isValidRawContent =
          Array.isArray(maybeRaw) &&
          maybeRaw.every((part) => {
            if (!part || typeof part !== "object") return false;
            const p = part as Record<string, unknown>;
            if (p.type === "text") return typeof p.text === "string";
            if (p.type === "image")
              return (
                typeof p.data === "string" && typeof p.mimeType === "string"
              );
            return false;
          });
        if (isValidRawContent) {
          const content = maybeRaw as McpToolResult["content"];
          this.logger.finalize(audit, {
            outputSize: content.length,
            itemCount: content.length,
          });
          this.sessionMemory.record(params.ref);
          return { content };
        }
      }

      const { items, hasMore } = this.shaper.shapeResponse(
        rawResult,
        entry.provider,
        params.detail,
      );

      let nextCursor: string | null = null;
      if (hasMore) {
        nextCursor = this.pagination.create({
          ref: params.ref,
          args: params.args,
          provider: entry.provider,
          originalName: entry.originalName,
          page: 2,
        });
      }

      const output = JSON.stringify(
        { items, next_cursor: nextCursor },
        null,
        2,
      );
      const truncated = this.enforceTokenLimit(output);

      this.logger.finalize(audit, {
        outputSize: truncated.length,
        itemCount: items.length,
      });

      this.sessionMemory.record(params.ref);
      return { content: [{ type: "text", text: truncated }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.logger.finalize(audit, { outputSize: 0, error: msg });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: msg, ref: params.ref }),
          },
        ],
      };
    }
  }

  private async handlePaginatedCall(
    params: CallParams,
  ): Promise<McpToolResult> {
    const state = this.pagination.resolve(params.page_cursor!);
    if (!state) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "Pagination cursor expired or invalid. Please re-execute the original query.",
            }),
          },
        ],
      };
    }

    const audit = this.logger.createEntry({
      tool: "mcp_call",
      provider: state.provider,
      args: state.args,
    });

    try {
      const rawResult = await this.connector.callTool(
        state.provider,
        state.originalName,
        state.args,
      );

      const offset = (state.page - 1) * this.config.callItemLimit;
      const { items, hasMore } = this.shaper.shapeResponse(
        rawResult,
        state.provider,
        params.detail,
        offset,
      );

      let nextCursor: string | null = null;
      if (hasMore) {
        nextCursor = this.pagination.create({
          ...state,
          page: state.page + 1,
        });
      }

      const output = JSON.stringify(
        { items, next_cursor: nextCursor },
        null,
        2,
      );
      const truncated = this.enforceTokenLimit(output);

      this.logger.finalize(audit, {
        outputSize: truncated.length,
        itemCount: items.length,
      });

      return { content: [{ type: "text", text: truncated }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.logger.finalize(audit, { outputSize: 0, error: msg });
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  private enforceTokenLimit(output: string): string {
    const maxChars = this.config.maxOutputTokens * 4;
    if (output.length <= maxChars) return output;
    const truncated = output.slice(0, maxChars - 200);
    return JSON.stringify({
      truncated: true,
      originalLength: output.length,
      content: truncated,
    });
  }

  private escapeToml(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  }

  private truncateText(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  }

  async startService(): Promise<void> {
    try {
      console.error("[proxy] Service mode — no stdio transport, HTTP only");
      this.dashboard.start();

      this.upstreamsReady = (async () => {
        try {
          await this.connector.discoverAll(this.config.upstreams);
          this.connector.startIdleReaper(this.config.idleTimeoutMs);
          this.buildAgentViews();
          console.error(
            `[proxy] Registry loaded: ${this.registry.size} tools from ${this.connector.discoveredProviders.length} providers (all idle)`,
          );
          console.error(
            `[proxy] Idle timeout: ${this.config.idleTimeoutMs > 0 ? `${this.config.idleTimeoutMs / 1000}s` : "disabled"}`,
          );
          console.error("[proxy] Search: pure lexical (BM25)");
          console.error(
            "[proxy] Exposing 3 tools: mcp_search, mcp_schema, mcp_call",
          );
          if (this.agentViews.size === 0) {
            console.error("[proxy] Agent isolation: DISABLED (open pool — all agents share all tools)");
          } else {
            console.error(`[proxy] Agent isolation: ENABLED (${this.agentViews.size} lanes)`);
          }
        } catch (error) {
          console.error(
            "[proxy] Failed to discover upstreams:",
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
      })();

      this.upstreamsReady.catch((error) => {
        console.error(
          "[proxy] Background upstream discovery failed:",
          error instanceof Error ? error.message : error,
        );
      });
    } catch (error) {
      console.error(
        "[proxy] Failed to start service:",
        error instanceof Error ? error.message : error,
      );
      await this.cleanup();
      process.exit(1);
    }
  }

  async start(): Promise<void> {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error(
        "[proxy] MCP transport connected, discovering upstreams in background...",
      );
      this.dashboard.start();

      this.upstreamsReady = (async () => {
        try {
          await this.connector.discoverAll(this.config.upstreams);
          this.connector.startIdleReaper(this.config.idleTimeoutMs);
          this.buildAgentViews();
          console.error(
            `[proxy] Registry loaded: ${this.registry.size} tools from ${this.connector.discoveredProviders.length} providers (all idle)`,
          );
          console.error(
            `[proxy] Idle timeout: ${this.config.idleTimeoutMs > 0 ? `${this.config.idleTimeoutMs / 1000}s` : "disabled"}`,
          );
          console.error("[proxy] Search: pure lexical (BM25)");
          console.error(
            "[proxy] Exposing 3 tools: mcp_search, mcp_schema, mcp_call",
          );
          if (this.agentViews.size === 0) {
            console.error("[proxy] Agent isolation: DISABLED (open pool — all agents share all tools)");
          } else {
            console.error(`[proxy] Agent isolation: ENABLED (${this.agentViews.size} lanes)`);
          }
        } catch (error) {
          console.error(
            "[proxy] Failed to discover upstreams:",
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
      })();

      this.upstreamsReady.catch((error) => {
        console.error(
          "[proxy] Background upstream discovery failed:",
          error instanceof Error ? error.message : error,
        );
      });
    } catch (error) {
      console.error(
        "[proxy] Failed to start:",
        error instanceof Error ? error.message : error,
      );
      await this.cleanup();
      process.exit(1);
    }
  }

  startHttpTransport(port: number): void {
    this.httpServer = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const parts = url.pathname.split("/").filter(Boolean);

        if (parts[0] !== "mcp" || parts.length > 2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const agentId = parts[1] ?? null;
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
          let transport = sessionId ? this.httpTransports.get(sessionId) : undefined;

          if (!transport && req.method === "POST") {
            await this.upstreamsReady;

            if (agentId !== null) {
              if (!this.agentViews.has(agentId)) {
                const known = [...this.agentViews.keys()].join(", ") || "none configured";
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Unknown agent: ${agentId}. Known agents: ${known}` }));
                return;
              }
            }

            const view = agentId ? this.agentViews.get(agentId) : null;
            const registry = view?.registry ?? this.registry;
            const search = view?.search ?? this.search;

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => {
                this.httpTransports.set(id, transport!);
                const lane = agentId ? `[${agentId}]` : "[open]";
                console.error(`[proxy] HTTP session created: ${id.slice(0, 8)}... ${lane}`);
              },
            });

            transport.onclose = () => {
              if (transport!.sessionId) {
                this.httpTransports.delete(transport!.sessionId);
              }
            };

            const sessionServer = new McpServer({ name: "mcp-proxy-gateway", version: "1.0.0" });
            this.registerToolsOn(sessionServer, registry, search);
            await sessionServer.connect(transport);
          }

          if (transport) {
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No valid session" }));
          }
        } else {
          res.writeHead(405);
          res.end("Method not allowed");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[proxy] HTTP handler error: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      }
    });

    this.httpServer.listen(port, "127.0.0.1", () => {
      console.error(`[proxy] HTTP transport listening on http://127.0.0.1:${port}/mcp`);
    });
  }

  async cleanup(): Promise<void> {
    try {
      this.connector.stopIdleReaper();
      this.dashboard.stop();
      if (this.httpServer) {
        this.httpServer.close();
        for (const transport of this.httpTransports.values()) {
          await transport.close();
        }
        this.httpTransports.clear();
      }
      await this.connector.disconnectAll();
    } catch (error) {
      console.error(
        "[proxy] Error during cleanup:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  setupGracefulShutdown(): void {
    const shutdown = async (signal: string): Promise<void> => {
      console.error(`[proxy] Received ${signal}, shutting down...`);
      await this.cleanup();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("uncaughtException", async (error) => {
      console.error("[proxy] Uncaught exception:", error);
      await this.cleanup();
      process.exit(1);
    });
    process.on("unhandledRejection", async (reason) => {
      console.error("[proxy] Unhandled rejection:", reason);
      await this.cleanup();
      process.exit(1);
    });
  }
}
