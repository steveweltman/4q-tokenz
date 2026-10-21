#!/usr/bin/env node

import { McpProxyServer, allowUnscopedRoute } from "./server.js";
import { BridgeServer } from "./bridge.js";
import { AGENT_ID_PATTERN } from "./types.js";
import {
  tryAcquireLock,
  readLock,
  releaseLock,
  isProcessAlive,
  cleanStaleLock,
  isPortInUse,
} from "./singleton.js";

const DEFAULT_SINGLETON_PORT = 9200;

function getSingletonPort(): number {
  return parseInt(
    process.env.MCP_PROXY_SINGLETON_PORT || String(DEFAULT_SINGLETON_PORT),
    10,
  );
}

/**
 * Bridge to the primary on this agent's lane. Fails closed: with no valid
 * MCP_PROXY_AGENT the bridge would reach an unscoped pool, so refuse to start.
 */
async function startAsBridge(port: number): Promise<void> {
  const agent = process.env.MCP_PROXY_AGENT;
  if (!agent && !allowUnscopedRoute()) {
    console.error("[bridge] MCP_PROXY_AGENT is not set; refusing to start without an agent lane");
    process.exit(1);
  }
  if (agent && !AGENT_ID_PATTERN.test(agent)) {
    console.error("[bridge] MCP_PROXY_AGENT is not a valid agent id; refusing to start");
    process.exit(1);
  }
  const bridge = new BridgeServer(port, agent || undefined);
  bridge.setupGracefulShutdown();
  await bridge.start();
}

function startAsPrimary(port: number): Promise<void> {
  console.error(
    `[singleton] PRIMARY mode (pid ${process.pid}, port ${port})`,
  );
  const server = McpProxyServer.fromEnvironment();

  const originalCleanup = server.cleanup.bind(server);
  server.cleanup = async () => {
    try {
      await originalCleanup();
    } finally {
      releaseLock();
    }
  };

  server.setupGracefulShutdown();

  const serviceMode = process.env.MCP_PROXY_SERVICE_MODE === "1";
  if (!serviceMode && !allowUnscopedRoute()) {
    // A stdio primary serves the whole pool to one unscoped client.
    console.error("[singleton] Refusing to run as an unscoped stdio primary. Run the service, or set MCP_PROXY_ALLOW_UNSCOPED=1 for local development.");
    process.exit(1);
  }
  if (serviceMode) {
    return server.startService().then(() => {
      server.startHttpTransport(port);
    });
  }
  return server.start().then(() => {
    server.startHttpTransport(port);
  });
}

try {
  const port = getSingletonPort();
  const acquired = tryAcquireLock(port);

  if (acquired && (await isPortInUse(port))) {
    // We won a lock the live primary does not know about (e.g. different lock dir),
    // but the port is served. Do not fight for it: release and bridge instead.
    console.error(`[singleton] Port ${port} already served; releasing lock and running as BRIDGE`);
    releaseLock();
    await startAsBridge(port);
  } else if (acquired) {
    await startAsPrimary(port);
  } else {
    const lock = readLock();

    if (!lock) {
      console.error("[singleton] Lock exists but unreadable, cleaning up");
      cleanStaleLock();
      const retryAcquired = tryAcquireLock(port);
      if (retryAcquired) {
        await startAsPrimary(port);
      } else {
        console.error("[singleton] Could not acquire lock after cleanup, exiting");
        process.exit(1);
      }
    } else if (!isProcessAlive(lock.pid)) {
      console.error(
        `[singleton] Primary (pid ${lock.pid}) is dead, promoting to primary`,
      );
      cleanStaleLock();
      const retryAcquired = tryAcquireLock(port);
      if (retryAcquired) {
        await startAsPrimary(port);
      } else {
        console.error("[singleton] Race condition: another process took the lock");
        const newLock = readLock();
        if (newLock) {
          console.error(
            `[singleton] BRIDGE mode → primary at pid ${newLock.pid}, port ${newLock.port}`,
          );
          await startAsBridge(newLock.port);
        } else {
          process.exit(1);
        }
      }
    } else {
      console.error(
        `[singleton] BRIDGE mode → primary at pid ${lock.pid}, port ${lock.port}`,
      );
      await startAsBridge(lock.port);
    }
  }
} catch (error) {
  console.error("Failed to start MCP Proxy Gateway:", error);
  if (error instanceof Error && error.stack) {
    console.error("Stack trace:", error.stack);
  }
  process.exit(1);
}

export { McpProxyServer } from "./server.js";
export { ToolRegistry } from "./registry.js";
export { McpConnectorManager } from "./connector.js";
export { HybridSearch } from "./search.js";
export { OutputShaper } from "./output-shaper.js";
export { PaginationManager } from "./pagination.js";
export { AuditLogger } from "./logger.js";
export { Dashboard } from "./dashboard.js";
export { BridgeServer } from "./bridge.js";
export {
  tryAcquireLock,
  readLock,
  releaseLock,
  isProcessAlive,
  cleanStaleLock,
} from "./singleton.js";
export * from "./types.js";
