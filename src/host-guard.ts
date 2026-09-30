// Rejects requests whose Host or Origin header is not loopback.
// Defends the local HTTP listeners against DNS rebinding and cross-site browser access.

import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(hostHeader: string): string {
  // "[::1]:9200" -> "[::1]", "127.0.0.1:9200" -> "127.0.0.1"
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(":")[0];
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host).toLowerCase())) return false;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase())) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
