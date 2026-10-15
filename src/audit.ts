/**
 * Audit log: one JSON line on stdout per write, Destructive Operation, or rejection.
 *
 * Every line has `type: "audit"`, `time` (ISO 8601) and `result`. Other stdout
 * lines (e.g. the startup `listening` line) use a different `type`.
 */
export type AuditResult = "ok" | "rejected" | "error";

export interface AuditEvent {
  result: AuditResult;
  /** Tool name, when the event comes from a tool call. */
  tool?: string;
  /** Root-relative Path(s) involved. */
  paths?: string[];
  /** Short machine-readable reason, e.g. "unauthorized", "forbidden". */
  reason?: string;
  /** Human-readable detail. */
  message?: string;
}

export function audit(event: AuditEvent): void {
  process.stdout.write(JSON.stringify({ type: "audit", time: new Date().toISOString(), ...event }) + "\n");
}

/** Non-audit informational line on stdout. */
export function logInfo(type: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ type, time: new Date().toISOString(), ...fields }) + "\n");
}
