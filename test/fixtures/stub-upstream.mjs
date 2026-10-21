// Minimal stdio MCP server used as a stand-in upstream for startup tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "stub-upstream", version: "1.0.0" });
server.registerTool("ping", { description: "Return pong" }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));
await server.connect(new StdioServerTransport());
