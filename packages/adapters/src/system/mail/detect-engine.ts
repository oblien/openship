/**
 * Which mail engine a box actually runs — the ONE mail topology probe.
 *
 * Two topologies exist in the field:
 *   - `container` — the supported one: the `openship-mail` engine + its
 *     `openship-mail-db` sidecar (see ensure-container-mail.ts).
 *   - `host` — a LEGACY pre-containerization install: iRedMail straight onto the
 *     box, Postfix/Dovecot as systemd units, vmail in the host PostgreSQL.
 *
 * The legacy shape is not a rounding error: the `openship-mail` image is not
 * published yet, so every mail box provisioned before containerization is still
 * host-native and cannot be migrated by pulling. Until it can, every mail code
 * path has to answer "which topology am I talking to" — and it has to get the
 * same answer everywhere, or the admin panel talks to a container that isn't
 * there while the fleet view calls a serving box "down".
 *
 * This is that answer. Everything downstream (SQL transport, daemon probes,
 * daemon actions, config paths) is a pure function of the flavor returned here —
 * see `apps/api/src/modules/mail/mail-engine.ts`, which owns that matrix. When
 * host-native finally retires, `flavor: "host"` stops being produced here and the
 * matrix collapses; no service needs touching.
 *
 * Pure read. Never mutates the box.
 */

import type { CommandExecutor } from "../../types";
import { MAIL_CONTAINER } from "../../infra/mail-container";
import { detectMailContainer, verifyMailEngine } from "./ensure-container-mail";
import type { SystemLog } from "../types";

/**
 * `container` = the openship-mail engine; `host` = legacy systemd iRedMail;
 * `none` = no mail engine on this box at all.
 */
export type MailEngineFlavor = "container" | "host" | "none";

export interface MailEngineProbe {
  flavor: MailEngineFlavor;
  /** The engine is serving: container running, or BOTH host units active. */
  running: boolean;
  /** The engine is provisioned (may be stopped). False only when flavor is "none". */
  exists: boolean;
  /** Running engine image ref — `container` flavor only. */
  image: string | null;
}

/** systemd units a legacy host-native install runs. Both must be up to serve. */
export const HOST_MAIL_UNITS = ["postfix", "dovecot"] as const;

/**
 * Probe the box for a mail engine.
 *
 * Container FIRST, and the container wins whenever it merely *exists* — even
 * stopped, even while host units still linger (a half-finished migration). The
 * reason is data, not liveness: once the sidecar exists, `vmail` lives there, so
 * pointing the admin panel at the host DB would read a stale copy. A stopped
 * container is reported `running: false`, which the caller surfaces as a repair.
 *
 * Neither probe throws: an unreachable Docker daemon or a box with no systemd at
 * all reads as "not that flavor", and both failing reads as `none`.
 */
export async function detectMailEngine(
  executor: CommandExecutor,
  container = MAIL_CONTAINER,
): Promise<MailEngineProbe> {
  const detected = await detectMailContainer(executor, container).catch(() => ({
    running: false,
    image: null as string | null,
    exists: false,
  }));
  if (detected.exists) {
    return {
      flavor: "container",
      running: detected.running,
      exists: true,
      image: detected.image,
    };
  }

  const host = await probeHostUnits(executor);
  if (host.installed) {
    return { flavor: "host", running: host.active, exists: true, image: null };
  }

  return { flavor: "none", running: false, exists: false, image: null };
}

/**
 * systemd state of the legacy units, in ONE exec.
 *
 * `systemctl show -p LoadState -p ActiveState` is used rather than `is-active`
 * because it distinguishes "installed but stopped" (LoadState=loaded,
 * ActiveState=inactive) from "not installed at all" (LoadState=not-found) — and
 * that distinction is the whole point here: a stopped legacy engine is a box we
 * must still recognise as a mail box, not a box with no mail.
 *
 * Properties are parsed as `KEY=value` rather than read positionally
 * (`--value`), so the order systemd emits them in can't shift the meaning.
 */
async function probeHostUnits(
  executor: CommandExecutor,
): Promise<{ installed: boolean; active: boolean }> {
  const script = HOST_MAIL_UNITS.map(
    (u) => `echo "## ${u}"; systemctl show ${u} -p LoadState -p ActiveState 2>/dev/null || true`,
  ).join("; ");
  const raw = await executor.exec(`{ ${script} ; } 2>/dev/null || true`).catch(() => "");

  const states = new Map<string, { load: string; active: string }>();
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const header = /^##\s+(\S+)$/.exec(trimmed);
    if (header) {
      current = header[1]!;
      states.set(current, { load: "", active: "" });
      continue;
    }
    if (!current) continue;
    const entry = states.get(current)!;
    if (trimmed.startsWith("LoadState=")) entry.load = trimmed.slice("LoadState=".length);
    else if (trimmed.startsWith("ActiveState=")) entry.active = trimmed.slice("ActiveState=".length);
  }

  // "loaded" or "masked" both mean the unit file is on the box: a masked postfix
  // is a legacy install someone disabled, not the absence of one.
  const loaded = (u: string) => ["loaded", "masked"].includes(states.get(u)?.load ?? "");
  const active = (u: string) => states.get(u)?.active === "active";
  return {
    installed: HOST_MAIL_UNITS.some(loaded),
    active: HOST_MAIL_UNITS.every(active),
  };
}

/**
 * Start a stopped LEGACY host-native engine — the `host` half of the one-click
 * repair whose `container` half is {@link startContainerMail}.
 *
 * Start-only by the same contract: no reinstall, no config rewrite, nothing that
 * could touch a live mailbox. Verification is the shared port check, which is
 * flavor-blind on purpose — the container runs `--network host`, so "something
 * answers on :25 and :993" is the same question either way.
 */
export async function startHostMail(
  executor: CommandExecutor,
  opts: { onLog: (log: SystemLog) => void; verifyTimeoutMs?: number },
): Promise<{ started: boolean; reason?: string }> {
  const log = (message: string, level: SystemLog["level"] = "info") =>
    opts.onLog({ timestamp: new Date().toISOString(), message, level });

  log(`Starting the host mail units (${HOST_MAIL_UNITS.join(", ")})...`);
  for (const unit of HOST_MAIL_UNITS) {
    // Best-effort per unit: report the outcome from the port check below, not from
    // systemctl's exit code (a unit already running exits non-zero on some builds).
    await executor.exec(`systemctl start ${unit} 2>&1 || true`).catch(() => "");
  }

  const verified = await verifyMailEngine(executor, opts);
  if (!verified.ok) {
    const reason = verified.reason ?? "the host mail units did not come up";
    log(`Could not start the host mail engine: ${reason}`, "error");
    const status = await executor
      .exec(`systemctl status ${HOST_MAIL_UNITS.join(" ")} --no-pager -l 2>&1 | tail -40 || true`)
      .catch(() => "");
    if (status.trim()) log(`Host mail unit status:\n${status}`, "error");
    return { started: false, reason };
  }

  log("Host mail engine running again");
  return { started: true };
}
