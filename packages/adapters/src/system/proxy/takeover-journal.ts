/**
 * The edge-takeover rollback journal — the ONE record of "what did we stop to get
 * :80/:443, and how do we put it back".
 *
 * Split out of takeover.ts for two reasons:
 *   • `runEdgeTakeover` (dashboard / bare self-install) does stop → install →
 *     register in ONE process, so it journals and rolls back internally.
 *   • `openship up` / the setup wizard CAN'T: the edge is a container that doesn't
 *     exist until `docker compose up` runs, so the host-side stop and the edge
 *     install happen in different processes. Those callers drive the same journal
 *     through `beginEdgeTakeover` → `completeEdgeTakeover` / `rollbackEdgeTakeover`.
 *   • This module imports nothing but `./detect` + types, so the CLI's lean
 *     `@repo/adapters/proxy` subpath can re-export it without pulling in the
 *     OpenResty installer, NginxProvider, ssh2 or dockerode.
 *
 * One journal file, one rollback implementation, one boot-recovery path — a
 * takeover abandoned by the CLI is restored by the api's `recoverInterruptedTakeover`
 * on the next boot, and vice versa.
 */

import type { CommandExecutor } from "../../types";
import type { EdgeStatus, SystemLog, SystemLogCallback } from "../types";
import { freeEdgeTargets, sq, stopTargetsForStatus } from "./detect";

const JOURNAL_DIR = "/var/lib/openship";
export const JOURNAL_PATH = `${JOURNAL_DIR}/edge-takeover.json`;

export interface TakeoverJournal {
  startedAt: string;
  units: Array<{ unit: string; wasEnabled: boolean }>;
  containers: Array<{ name: string; restart: string }>;
  /** Bare (non-systemd, non-docker) processes we killed — relaunched on rollback. */
  processes: Array<{ pid: number; command?: string }>;
  /** Set true only after the takeover finished; recovery rolls back if absent. */
  completed?: boolean;
}

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

async function tryExec(executor: CommandExecutor, cmd: string): Promise<string | null> {
  try {
    return await executor.exec(cmd);
  } catch {
    return null;
  }
}

/** Capture how to restore each foreign owner before we stop/disable it. */
export async function buildJournal(
  executor: CommandExecutor,
  status: EdgeStatus,
): Promise<TakeoverJournal> {
  const units = new Map<string, { unit: string; wasEnabled: boolean }>();
  const containers = new Map<string, { name: string; restart: string }>();
  const processes = new Map<number, { pid: number; command?: string }>();

  for (const o of status.occupants) {
    if (o.containerName && !containers.has(o.containerName)) {
      const r = await tryExec(
        executor,
        `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${sq(o.containerName)} 2>/dev/null`,
      );
      containers.set(o.containerName, { name: o.containerName, restart: r?.trim() || "no" });
    } else if (o.systemdUnit && !units.has(o.systemdUnit)) {
      const en = await tryExec(executor, `systemctl is-enabled ${sq(o.systemdUnit)} 2>/dev/null`);
      units.set(o.systemdUnit, { unit: o.systemdUnit, wasEnabled: en?.trim() === "enabled" });
    } else if (!o.containerName && !o.systemdUnit && o.pid && !processes.has(o.pid)) {
      // Bare process — record its command line so rollback can relaunch it.
      processes.set(o.pid, { pid: o.pid, command: o.rawCommand });
    }
  }

  return {
    startedAt: new Date().toISOString(),
    units: [...units.values()],
    containers: [...containers.values()],
    processes: [...processes.values()],
  };
}

export async function writeJournal(
  executor: CommandExecutor,
  journal: TakeoverJournal,
): Promise<void> {
  try {
    await executor.mkdir(JOURNAL_DIR);
    await executor.writeFile(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  } catch {
    // Non-fatal: an in-process rollback still works; only crash-recovery is lost.
  }
}

export async function clearJournal(executor: CommandExecutor): Promise<void> {
  await tryExec(executor, `rm -f ${JOURNAL_PATH}`);
}

export async function readJournal(executor: CommandExecutor): Promise<TakeoverJournal | null> {
  const raw = await tryExec(executor, `cat ${JOURNAL_PATH} 2>/dev/null`);
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as TakeoverJournal;
  } catch {
    await clearJournal(executor);
    return null;
  }
}

/** Restart & re-enable the foreign proxy captured in the journal. */
export async function rollback(
  executor: CommandExecutor,
  journal: TakeoverJournal,
  onLog: SystemLogCallback,
): Promise<void> {
  onLog(log("Rolling back — restoring the previous proxy...", "warn"));
  // Stop AND disable OpenResty so it releases 80/443 durably — otherwise both it
  // and the restored proxy stay `enabled` and race for the port on next reboot.
  await tryExec(
    executor,
    "systemctl disable --now openresty 2>/dev/null || systemctl stop openresty 2>/dev/null || true; " +
      "systemctl reset-failed openresty 2>/dev/null || true",
  );
  for (const u of journal.units) {
    await tryExec(
      executor,
      u.wasEnabled
        ? `systemctl enable --now ${sq(u.unit)} 2>/dev/null || true`
        : `systemctl start ${sq(u.unit)} 2>/dev/null || true`,
    );
  }
  for (const c of journal.containers) {
    await tryExec(executor, `docker update --restart=${sq(c.restart)} ${sq(c.name)} 2>/dev/null || true`);
    await tryExec(executor, `docker start ${sq(c.name)} 2>/dev/null || true`);
  }
  for (const p of journal.processes ?? []) {
    if (p.command) {
      // Best-effort relaunch, detached from this session.
      await tryExec(
        executor,
        `setsid -f sh -c ${sq(p.command)} 2>/dev/null || (nohup sh -c ${sq(p.command)} >/dev/null 2>&1 &) || true`,
      );
    } else {
      onLog(log(`Could not restore process ${p.pid} — no command captured.`, "warn"));
    }
  }
}

/**
 * Phase 1 of a two-process takeover: snapshot how to restore the foreign proxy,
 * THEN free the ports. The caller must finish with `completeEdgeTakeover` on
 * success or `rollbackEdgeTakeover` on failure — otherwise the next boot's
 * recovery sees an unfinished journal and restores the old proxy.
 */
export async function beginEdgeTakeover(
  executor: CommandExecutor,
  status: EdgeStatus,
  onLog: SystemLogCallback,
): Promise<void> {
  await writeJournal(executor, await buildJournal(executor, status));
  await freeEdgeTargets(executor, stopTargetsForStatus(status), (m, l) => onLog(log(m, l)));
}

/**
 * Restore whatever `beginEdgeTakeover` stopped. False when there's no unfinished
 * journal, so a caller can tell "restored your proxy" from "nothing to restore".
 */
export async function rollbackEdgeTakeover(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<boolean> {
  const journal = await readJournal(executor);
  if (!journal || journal.completed) return false;
  await rollback(executor, journal, onLog);
  await clearJournal(executor);
  return true;
}

/** Mark the two-process takeover finished so boot recovery leaves it alone. */
export async function completeEdgeTakeover(executor: CommandExecutor): Promise<void> {
  const journal = await readJournal(executor);
  if (journal) {
    journal.completed = true;
    await writeJournal(executor, journal);
  }
  await clearJournal(executor);
}

/**
 * On boot, a journal that is present but not `completed` means a previous run
 * crashed mid-flight — restore the foreign proxy so 80/443 aren't left dark.
 * `isEdgeHealthy` lets the caller skip the restore when OUR edge is in fact up
 * (the run finished but never got to clear the journal); restarting the old proxy
 * then would just fight our edge for the port.
 */
export async function recoverInterruptedTakeover(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
  isEdgeHealthy?: () => Promise<boolean>,
): Promise<void> {
  const journal = await readJournal(executor);
  if (!journal) return;

  if (journal.completed) {
    await clearJournal(executor);
    return;
  }

  if (isEdgeHealthy && (await isEdgeHealthy())) {
    onLog(log("Found an unfinished edge takeover, but our edge is serving — keeping it.", "warn"));
    await clearJournal(executor);
    return;
  }

  onLog(log("Found an interrupted edge takeover — restoring the previous proxy.", "warn"));
  await rollback(executor, journal, onLog);
  await clearJournal(executor);
}
