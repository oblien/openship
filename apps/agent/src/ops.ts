import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentOp } from "./protocol";
import { buildMutex } from "./mutex";
import { collectReport } from "./report";
import { incompleteEntries, type OperationJournal } from "./journal";

const execFileAsync = promisify(execFile);

export type OpResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  [key: string]: unknown;
};

async function run(cmd: string, args: string[], timeout = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? String(err),
    };
  }
}

async function ping(): Promise<OpResult> {
  return { ok: true, ts: Date.now() };
}

async function renewCerts(): Promise<OpResult> {
  const which = await run("sh", ["-c", "command -v certbot"]);
  if (which.code !== 0) return { ok: true, skipped: true, reason: "no certbot" };
  const result = await run("certbot", ["renew", "--quiet"], 180_000);
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
  };
}

async function runBackup(payload: unknown): Promise<OpResult> {
  const plan = payload && typeof payload === "object" ? (payload as { command?: unknown; args?: unknown }) : {};
  if (typeof plan.command !== "string" || plan.command.length === 0) {
    // Control plane still owns destination credentials; fall back there.
    return { ok: true, skipped: true, reason: "no local plan" };
  }
  const args = Array.isArray(plan.args) ? plan.args.map(String) : [];
  const result = await run(plan.command, args, 10 * 60_000);
  return { ok: result.code === 0, code: result.code, stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000) };
}

async function healthCheck(): Promise<OpResult> {
  const report = await collectReport();
  return { ok: true, ...report };
}

async function recoverReleases(journal: OperationJournal): Promise<OpResult> {
  const leftover = await run("docker", [
    "ps",
    "-a",
    "--filter",
    "name=openship-release-",
    "--filter",
    "status=exited",
    "--format",
    "{{.ID}}",
  ]);
  const ids = leftover.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  let removed = 0;
  for (const id of ids) {
    const rm = await run("docker", ["rm", "-f", id]);
    if (rm.code === 0) removed += 1;
  }
  const incomplete = incompleteEntries(journal.readAll()).filter((e) => e.op === "execute_release");
  return { ok: true, removedBuilders: removed, incompleteReleases: incomplete.length };
}

async function executeRelease(payload: unknown): Promise<OpResult> {
  return buildMutex.run(async () => {
    const plan = payload && typeof payload === "object" ? (payload as { steps?: unknown }) : {};
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (steps.length === 0) {
      return { ok: true, accepted: true, steps: 0 };
    }
    const results: Array<{ ok: boolean; stdout?: string; stderr?: string }> = [];
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as { command?: unknown; args?: unknown };
      if (typeof s.command !== "string") continue;
      const args = Array.isArray(s.args) ? s.args.map(String) : [];
      const result = await run(s.command, args, 10 * 60_000);
      results.push({
        ok: result.code === 0,
        stdout: result.stdout.slice(0, 2000),
        stderr: result.stderr.slice(0, 2000),
      });
      if (result.code !== 0) return { ok: false, steps: results };
    }
    return { ok: true, steps: results };
  });
}

export async function executeOp(
  op: AgentOp,
  payload: unknown,
  journal: OperationJournal,
): Promise<OpResult> {
  switch (op) {
    case "ping":
      return ping();
    case "report":
      return { ok: true, ...(await collectReport()) };
    case "renew_certs":
      return renewCerts();
    case "run_backup":
      return runBackup(payload);
    case "health_check":
      return healthCheck();
    case "recover_releases":
      return recoverReleases(journal);
    case "execute_release":
      return executeRelease(payload);
  }
}
