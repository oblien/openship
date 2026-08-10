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
import type { EdgeStatus, EdgeStopTarget, SystemLog, SystemLogCallback } from "../types";
import {
  EDGE_CONTAINER_NAME,
  freeEdgeTargets,
  sq,
  stopTargetsForStatus,
  type EdgeFreeResult,
} from "./detect";

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

/**
 * Restart & re-enable the foreign proxy captured in the journal, and report
 * whether the box is ACTUALLY serving :80 afterwards.
 *
 * `executor` must reach the HOST — never wrap it in `edgeContainerExecutor`, or the
 * `docker stop` below runs inside the edge container and stops nothing (the same
 * namespace trap that broke the vhost rename).
 */
export async function rollback(
  executor: CommandExecutor,
  journal: TakeoverJournal,
  onLog: SystemLogCallback,
): Promise<boolean> {
  onLog(log("Rolling back — restoring the previous proxy...", "warn"));
  // Release 80/443 from OUR edge first, or every restore below fails to bind and
  // the box is left dark with a "restored" message.
  //
  // The CONTAINER edge is the one that actually holds the ports today — this used
  // to stop only the openresty UNIT, which on a container box isn't running at all,
  // so `docker start <their-nginx>` hit "address already in use" while
  // openship-edge kept the socket. Both are attempted: the unit for a legacy bare
  // edge, the container for every current one. `--restart=no` before the stop, or
  // the daemon brings it straight back and re-takes the port.
  await tryExec(executor, `docker update --restart=no ${sq(EDGE_CONTAINER_NAME)} 2>/dev/null || true`);
  await tryExec(executor, `docker stop ${sq(EDGE_CONTAINER_NAME)} 2>/dev/null || true`);
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

  // PROVE it. Every command above is `tryExec` + `|| true`, which is right for a
  // best-effort restore of someone else's service — but it means this function
  // could do nothing at all and the caller would still tell the operator "your
  // previous proxy has been restarted, the box is serving again". That sentence is
  // the difference between "retry when convenient" and "your sites are down right
  // now", so it has to be earned.
  const restored = await portIsServed(executor, 80);
  if (!restored) {
    onLog(
      log(
        "Nothing is listening on :80 after the restore — the box is NOT serving. " +
          "Start your proxy by hand (e.g. `systemctl start nginx`, or `docker start <name>`).",
        "error",
      ),
    );
  }
  return restored;
}

/**
 * Is anything LISTENING on `port`? `ss` where present, /proc/net/tcp otherwise —
 * no curl, no wget, nothing that may be absent on a minimal box. Hex `0050` is 80,
 * state `0A` is LISTEN.
 */
async function portIsServed(executor: CommandExecutor, port: number): Promise<boolean> {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const out = await tryExec(
    executor,
    `(command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ':${port}[[:space:]]' && echo yes) || ` +
      `(grep -qiE '^[[:space:]]*[0-9]+:[[:space:]]*[0-9A-F]{8}:${hex}[[:space:]]+[0-9A-F]{8}:0000[[:space:]]+0A' /proc/net/tcp 2>/dev/null && echo yes) || true`,
  );
  return (out ?? "").includes("yes");
}

/**
 * Phase 1 of a takeover: snapshot how to restore the foreign proxy, THEN free the
 * ports. The caller must finish with `completeEdgeTakeover` on success or
 * `rollbackEdgeTakeover` on failure — otherwise the next boot's recovery sees an
 * unfinished journal and restores the old proxy.
 *
 * Returns the port-free proof, so a caller can refuse to start anything on a
 * handover that didn't actually happen instead of learning it from a crash loop.
 *
 * `targets` overrides what to stop, for a pre-accepted `edgePolicy.stopTargets`.
 * The journal is still built from `status`, because restoring is about the OWNERS
 * we found, not the subset a policy named.
 */
export async function beginEdgeTakeover(
  executor: CommandExecutor,
  status: EdgeStatus,
  onLog: SystemLogCallback,
  targets?: EdgeStopTarget[],
): Promise<EdgeFreeResult> {
  await writeJournal(executor, await buildJournal(executor, status));
  return freeEdgeTargets(
    executor,
    targets?.length ? targets : stopTargetsForStatus(status),
    (m, l) => onLog(log(m, l)),
  );
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
  const restored = await rollback(executor, journal, onLog);
  // Clear it either way: a journal that can't be acted on successfully is not one
  // the next boot should replay. `restored` is what the caller tells the operator.
  await clearJournal(executor);
  return restored;
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
