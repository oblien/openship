/**
 * Edge takeover with config migration.
 *
 * Given the foreign proxy owning 80/443 and the sites parsed from its config,
 * this: snapshots what it's about to stop (rollback journal on disk) → stops &
 * disables the foreign proxy → installs OpenResty → re-registers the imported
 * sites as Openship routes → reuses/issues their certs → verifies. Any failure
 * rolls back (re-enable the foreign proxy) so the box is never left dark.
 *
 * The on-disk journal lets a crash mid-run be rolled back on the next boot
 * (recoverInterruptedTakeover), so an interrupted migrate can't strand 80/443.
 */

import { safeErrorMessage } from "@repo/core";
import type { CommandExecutor } from "../../types";
import type { EdgeStatus, ImportedSite, SystemLog, SystemLogCallback } from "../types";
import { freeEdgeTargets, sq, stopTargetsForStatus } from "./detect";
import { installOpenResty } from "../installer";
import { checkOpenResty } from "../checks";
import { NginxProvider } from "../../infra/nginx";
import { detectOpenRestyPaths } from "../../infra/openresty-lua";

const JOURNAL_DIR = "/var/lib/openship";
const JOURNAL_PATH = `${JOURNAL_DIR}/edge-takeover.json`;
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

/** A filesystem path safe to pass to the shell (absolute, no metacharacters). */
function isSafePath(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(p);
}

async function tryExec(executor: CommandExecutor, cmd: string): Promise<string | null> {
  try {
    return await executor.exec(cmd);
  } catch {
    return null;
  }
}

interface TakeoverJournal {
  startedAt: string;
  units: Array<{ unit: string; wasEnabled: boolean }>;
  containers: Array<{ name: string; restart: string }>;
  /** Bare (non-systemd, non-docker) processes we killed — relaunched on rollback. */
  processes: Array<{ pid: number; command?: string }>;
  /** Set true only after all routes are registered; recovery rolls back if absent. */
  completed?: boolean;
}

export interface EdgeTakeoverOptions {
  status: EdgeStatus;
  sites: ImportedSite[];
  acmeEmail?: string;
  /** Extra routes to register beyond the imported sites (e.g. the control plane's own hostname). */
  extraRoutes?: Array<{ domain: string; targetUrl: string; tls: boolean }>;
}

export interface EdgeTakeoverResult {
  ok: boolean;
  rolledBack: boolean;
  registered: string[];
  warnings: string[];
}

/** Capture how to restore each foreign owner before we stop/disable it. */
async function buildJournal(executor: CommandExecutor, status: EdgeStatus): Promise<TakeoverJournal> {
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

async function writeJournal(executor: CommandExecutor, journal: TakeoverJournal): Promise<void> {
  try {
    await executor.mkdir(JOURNAL_DIR);
    await executor.writeFile(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  } catch {
    // Non-fatal: rollback still runs in-process; only crash-recovery is lost.
  }
}

async function clearJournal(executor: CommandExecutor): Promise<void> {
  await tryExec(executor, `rm -f ${JOURNAL_PATH}`);
}

/** Restart & re-enable the foreign proxy captured in the journal. */
async function rollback(
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
      await tryExec(executor, `setsid -f sh -c ${sq(p.command)} 2>/dev/null || (nohup sh -c ${sq(p.command)} >/dev/null 2>&1 &) || true`);
    } else {
      onLog(log(`Could not restore process ${p.pid} — no command captured.`, "warn"));
    }
  }
}

async function registerSite(
  nginx: NginxProvider,
  executor: CommandExecutor,
  site: ImportedSite,
  onLog: SystemLogCallback,
  warnings: string[],
): Promise<string[]> {
  const registered: string[] = [];
  const domains = site.serverNames.filter((d) => {
    if (DOMAIN_RE.test(d) && d.length <= 253) return true;
    warnings.push(`skipped unsupported domain "${d}" (wildcards/regex names aren't migratable)`);
    return false;
  });

  for (const domain of domains) {
    try {
      if (site.target.kind === "proxy") {
        await nginx.registerRoute({ domain, tls: site.ssl, targetUrl: site.target.url });
      } else {
        await nginx.registerRoute({ domain, tls: site.ssl, staticRoot: site.target.root });
      }

      if (site.ssl) {
        // Reuse the existing cert only when both paths are safe absolute paths
        // (they come from parsing the foreign config — never trust them raw in a shell).
        const reusable = site.tls && isSafePath(site.tls.certPath) && isSafePath(site.tls.keyPath);
        if (site.tls && !reusable) {
          warnings.push(`${domain}: existing cert path looks unsafe — issuing a fresh certificate instead`);
        }
        if (reusable) {
          const certPem = await tryExec(executor, `cat ${sq(site.tls!.certPath)} 2>/dev/null`);
          const keyPem = await tryExec(executor, `cat ${sq(site.tls!.keyPath)} 2>/dev/null`);
          if (certPem && keyPem) {
            await nginx.installCert(domain, { certPem, keyPem });
          } else {
            const r = await nginx.provisionCert(domain);
            if (!r.verified) warnings.push(`${domain}: TLS not ready yet (${r.reason ?? "pending"})`);
          }
        } else {
          const r = await nginx.provisionCert(domain);
          if (!r.verified) warnings.push(`${domain}: TLS not ready yet (${r.reason ?? "pending"})`);
        }
      }

      onLog(log(`Migrated ${domain} → ${site.target.kind === "proxy" ? site.target.url : site.target.root}`));
      registered.push(domain);
    } catch (err) {
      warnings.push(`${domain}: ${safeErrorMessage(err)}`);
    }
  }
  return registered;
}

/**
 * Stop the foreign proxy, install OpenResty, and re-register the imported sites.
 * Rolls back on failure. Assumes the caller already has explicit user consent.
 */
export async function runEdgeTakeover(
  executor: CommandExecutor,
  opts: EdgeTakeoverOptions,
  onLog: SystemLogCallback,
): Promise<EdgeTakeoverResult> {
  const warnings: string[] = [];
  const journal = await buildJournal(executor, opts.status);
  await writeJournal(executor, journal);

  onLog(log(`Migrating ${opts.sites.length} site(s) from the existing proxy, then taking over 80/443...`));
  await freeEdgeTargets(executor, stopTargetsForStatus(opts.status), (m, l) => onLog(log(m, l)));

  // Install OpenResty (ports are now free; takeover authorized as a backstop).
  const install = await installOpenResty(executor, onLog, {
    edgePolicy: { mode: "takeover", stopTargets: [] },
  });
  if (!install.success) {
    await rollback(executor, journal, onLog);
    await clearJournal(executor);
    return { ok: false, rolledBack: true, registered: [], warnings: [install.error ?? "OpenResty install failed"] };
  }

  try {
    const paths = await detectOpenRestyPaths(executor);
    const nginx = new NginxProvider({ paths, executor, acmeEmail: opts.acmeEmail });

    const registered: string[] = [];
    for (const site of opts.sites) {
      registered.push(...(await registerSite(nginx, executor, site, onLog, warnings)));
    }

    for (const route of opts.extraRoutes ?? []) {
      try {
        await nginx.registerRoute({ domain: route.domain, tls: route.tls, targetUrl: route.targetUrl });
        if (route.tls) await nginx.provisionCert(route.domain);
        registered.push(route.domain);
      } catch (err) {
        warnings.push(`${route.domain}: ${safeErrorMessage(err)}`);
      }
    }

    const health = await checkOpenResty(executor);
    if (!health.healthy) {
      warnings.push(`OpenResty came up but isn't fully healthy: ${health.message}`);
    }

    // Mark done BEFORE clearing so a crash in the tiny window here (or a failed
    // clear) is recognized as complete rather than rolled back.
    journal.completed = true;
    await writeJournal(executor, journal);
    await clearJournal(executor);
    onLog(log(`Takeover complete — ${registered.length} route(s) now served by Openship.`));
    return { ok: true, rolledBack: false, registered, warnings };
  } catch (err) {
    warnings.push(safeErrorMessage(err));
    await rollback(executor, journal, onLog);
    await clearJournal(executor);
    return { ok: false, rolledBack: true, registered: [], warnings };
  }
}

/**
 * On boot, if a takeover journal is present it means a previous run crashed
 * mid-flight (success clears it). If OpenResty isn't healthy, restore the
 * foreign proxy so 80/443 aren't left dark; otherwise just clear the journal.
 */
export async function recoverInterruptedTakeover(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<void> {
  const raw = await tryExec(executor, `cat ${JOURNAL_PATH} 2>/dev/null`);
  if (!raw?.trim()) return;

  let journal: TakeoverJournal;
  try {
    journal = JSON.parse(raw);
  } catch {
    await clearJournal(executor);
    return;
  }

  // A finished run marks the journal completed before clearing it. A journal
  // present WITHOUT that marker means the run didn't finish (routes may be
  // half-registered even if OpenResty is "healthy") → restore the old proxy.
  if (journal.completed) {
    await clearJournal(executor);
    return;
  }

  onLog(log("Found an interrupted edge takeover — restoring the previous proxy.", "warn"));
  await rollback(executor, journal, onLog);
  await clearJournal(executor);
}
