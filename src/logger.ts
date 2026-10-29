import { AuditEntry } from "./types.js";

export interface CallMetrics {
  callsTotal: ReadonlyMap<string, number>;
  durationSumMs: ReadonlyMap<string, number>;
  outputBytesTotal: ReadonlyMap<string, number>;
  startTime: number;
}

export class AuditLogger {
  private entries: AuditEntry[] = [];
  private maxEntries = 1000;

  private readonly _callsTotal = new Map<string, number>();
  private readonly _durationSumMs = new Map<string, number>();
  private readonly _outputBytesTotal = new Map<string, number>();
  private readonly startTime = Date.now();

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    console.error(
      `[audit]${entry.agent ? ` [${entry.agent}]` : ""} ${entry.tool} via ${entry.provider} | ${entry.executionTimeMs}ms | ${entry.outputSize}b` +
        (entry.error ? ` | ERROR: ${entry.error}` : "")
    );
  }

  getEntries(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit);
  }

  createEntry(
    partial: Pick<AuditEntry, "tool" | "provider" | "args" | "agent">
  ): AuditEntry & { _start: number } {
    return {
      ...partial,
      timestamp: new Date().toISOString(),
      outputSize: 0,
      executionTimeMs: 0,
      _start: Date.now(),
    };
  }

  finalize(
    entry: AuditEntry & { _start: number },
    result: { outputSize: number; itemCount?: number; error?: string }
  ): void {
    entry.executionTimeMs = Date.now() - entry._start;
    entry.outputSize = result.outputSize;
    entry.itemCount = result.itemCount;
    entry.error = result.error;
    this.log(entry);
    this.recordMetrics(entry);
  }

  getMetrics(): CallMetrics {
    return {
      callsTotal: this._callsTotal,
      durationSumMs: this._durationSumMs,
      outputBytesTotal: this._outputBytesTotal,
      startTime: this.startTime,
    };
  }

  private recordMetrics(entry: AuditEntry): void {
    const status = entry.error ? "error" : "success";
    const callKey = `${entry.tool}\x00${entry.provider}\x00${status}`;
    this._callsTotal.set(callKey, (this._callsTotal.get(callKey) ?? 0) + 1);

    const perfKey = `${entry.tool}\x00${entry.provider}`;
    this._durationSumMs.set(perfKey, (this._durationSumMs.get(perfKey) ?? 0) + entry.executionTimeMs);
    this._outputBytesTotal.set(perfKey, (this._outputBytesTotal.get(perfKey) ?? 0) + entry.outputSize);
  }
}
