import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentOp } from "./protocol";

export type JournalStatus = "pending" | "running" | "done" | "failed";

export type JournalEntry = {
  id: string;
  op: AgentOp;
  payload: unknown;
  status: JournalStatus;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
};

export function newJournalId(): string {
  return `op_${randomBytes(12).toString("hex")}`;
}

/** Latest row per id. Append-only JSONL; later lines win. */
export function foldJournal(lines: string[]): Map<string, JournalEntry> {
  const byId = new Map<string, JournalEntry>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const row = parsed as Partial<JournalEntry>;
    if (typeof row.id !== "string" || typeof row.op !== "string") continue;
    byId.set(row.id, row as JournalEntry);
  }
  return byId;
}

export function incompleteEntries(byId: Map<string, JournalEntry>): JournalEntry[] {
  return [...byId.values()].filter((e) => e.status === "pending" || e.status === "running");
}

export class OperationJournal {
  constructor(private readonly path: string) {}

  readAll(): Map<string, JournalEntry> {
    if (!existsSync(this.path)) return new Map();
    return foldJournal(readFileSync(this.path, "utf8").split("\n"));
  }

  append(entry: JournalEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  begin(op: AgentOp, payload: unknown, id = newJournalId()): JournalEntry {
    const entry: JournalEntry = {
      id,
      op,
      payload,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.append(entry);
    return entry;
  }

  finish(id: string, result: unknown): void {
    const prev = this.readAll().get(id);
    if (!prev) return;
    this.append({
      ...prev,
      status: "done",
      finishedAt: new Date().toISOString(),
      result,
      error: undefined,
    });
  }

  fail(id: string, error: string): void {
    const prev = this.readAll().get(id);
    if (!prev) return;
    this.append({
      ...prev,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error,
    });
  }

  isDone(id: string): boolean {
    return this.readAll().get(id)?.status === "done";
  }
}
