import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";

export interface LockInfo {
  pid: number;
  port: number;
}

const LOCK_FILENAME = "mcp-proxy.lock";

function getLockPath(): string {
  // Prefer the per-user runtime dir so other local users cannot pre-create the lock.
  const dir = process.env.MCP_PROXY_LOCK_DIR || process.env.XDG_RUNTIME_DIR || userRuntimeDir() || tmpdir();
  return join(dir, LOCK_FILENAME);
}

// Hosts such as the OpenClaw gateway spawn us with a minimal env that lacks
// XDG_RUNTIME_DIR; derive the standard per-user dir so every instance agrees on the lock.
function userRuntimeDir(): string | null {
  if (typeof process.getuid !== "function") return null;
  const dir = `/run/user/${process.getuid()}`;
  return existsSync(dir) ? dir : null;
}

/** True if something is already accepting TCP connections on the loopback port. */
export function isPortInUse(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryAcquireLock(port: number): boolean {
  const lockPath = getLockPath();

  try {
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      const info: LockInfo = { pid: process.pid, port };
      writeSync(fd, JSON.stringify(info));
      return true;
    } finally {
      closeSync(fd);
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }

  const existing = readLock();
  if (!existing) {
    return false;
  }

  if (!isProcessAlive(existing.pid)) {
    console.error(`[singleton] Stale lock (pid ${existing.pid} dead), taking over`);
    unlinkSync(lockPath);
    return tryAcquireLock(port);
  }

  return false;
}

export function readLock(): LockInfo | null {
  const lockPath = getLockPath();
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === "number" && typeof parsed.port === "number") {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function cleanStaleLock(): boolean {
  const existing = readLock();
  if (!existing) return false;
  if (isProcessAlive(existing.pid)) return false;

  const lockPath = getLockPath();
  try {
    unlinkSync(lockPath);
    console.error(`[singleton] Cleaned stale lock (pid ${existing.pid} dead)`);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  const lockPath = getLockPath();
  try {
    const existing = readLock();
    if (existing && existing.pid === process.pid) {
      unlinkSync(lockPath);
      console.error("[singleton] Lock released");
    }
  } catch {
    // best-effort
  }
}
