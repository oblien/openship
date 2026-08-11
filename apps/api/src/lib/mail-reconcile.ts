import {
  dockerAvailable,
  detectMailContainer,
  detectMailEngine,
  ensureContainerMail,
  startContainerMail,
  startHostMail,
  type CommandExecutor,
  type SystemLog,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

import { deliverManagedImage } from "./deliver-managed-image";
import { pinnedMailImage } from "./mail-image";

/**
 * Converge a server's mail ENGINE onto the pinned container image — the mail
 * sibling of {@link reconcileServerEdge}.
 *
 * ── Swap ONLY, never first boot ──
 *
 * `ensureContainerMail` has two paths: an image SWAP when an engine is already
 * running (data + DB persist on host binds, only the image moves), and a
 * FIRST-BOOT bring-up that writes the secret env-files from `opts.secrets` and
 * templates `FIRST_DOMAIN` in. An update must only ever take the swap path — the
 * secrets are provisioned once by the mail-setup wizard and are NOT re-derivable
 * here, so a first boot with empty secrets would re-template a live mailbox and
 * lose it. We therefore gate on a RUNNING engine and bail otherwise: a mail box
 * that isn't up is a setup/repair concern, not an update one.
 *
 * On the swap path `ensureContainerMail` reads only `domain` (for the engine's
 * `--hostname mail.<domain>`) and reuses the on-disk env-file, so `secrets: {}`
 * is correct and never written. The swap is rollback-guarded: a new image that
 * fails to come up rolls back to the previous one, and only a failed rollback
 * reports `mailDown`.
 *
 * Best-effort by contract, like the edge reconcile: a throw is caught and
 * reported, and the swap path itself never throws (it reports `mailDown`).
 */
export async function reconcileServerMail(
  executor: CommandExecutor,
  opts: {
    onLog: (log: SystemLog) => void;
    /** The provisioned base mail domain (from `repos.mailServer`). */
    domain: string;
  },
): Promise<{ updated: boolean; mailDown: boolean; ran: boolean; error?: string }> {
  if (!(await dockerAvailable(executor).catch(() => false))) {
    return { updated: false, mailDown: false, ran: false };
  }

  // Only reconcile a LIVE engine — see the swap-only rationale above.
  const detected = await detectMailContainer(executor).catch(() => null);
  if (!detected?.running) {
    return { updated: false, mailDown: false, ran: false };
  }

  try {
    const image = pinnedMailImage();
    // Stage-B APPLY: build our source onto this box (or ship + build for a remote one)
    // so the swap below adopts the dev engine image instead of pulling an unpublished
    // tag. No-op in prod (no checkout → deliver returns immediately).
    await deliverManagedImage({ kind: "mail", image, targetExecutor: executor, onLog: opts.onLog });
    const result = await ensureContainerMail(executor, {
      onLog: opts.onLog,
      domain: opts.domain,
      secrets: {},
      image,
    });
    return {
      updated: Boolean(result.updated),
      mailDown: Boolean(result.mailDown),
      ran: true,
    };
  } catch (err) {
    const error = safeErrorMessage(err);
    opts.onLog({
      timestamp: new Date().toISOString(),
      level: "warn",
      message:
        `The mail engine stays on its previous image (${error}) — ` +
        `the update is retried later.`,
    });
    // Reported, not swallowed: all-false is also what an already-current engine
    // returns, so an operator-initiated update needs `error` to tell a failed swap
    // apart from "nothing to do" (same rule as the edge — see EdgeReconcileResult).
    return { updated: false, mailDown: false, ran: true, error };
  }
}

/**
 * Bring a STOPPED mail engine back up — the repair sibling of
 * {@link reconcileServerMail}, which by design refuses a non-running engine (see the
 * swap-only rationale above). That refusal left a stopped engine with no one-click
 * recovery even though the fix is just a start; this is that path.
 *
 * Works on BOTH topologies, because a legacy host-native box is exactly the box
 * most likely to need it (the engine image isn't published yet, so every mail
 * server provisioned before containerization is host-native): the flavor decides
 * `docker start` vs `systemctl start`, and `detectMailEngine` decides the flavor.
 *
 * Start-only on both sides — no recreate, no reinstall, no config or env-file
 * write — so secrets and mailbox data are untouched by construction. A MISSING
 * engine isn't repaired here: that needs the secrets only mail setup has, so it
 * comes back as a reason.
 *
 * Best-effort by contract, like its siblings: never throws. `mailDown` stays true
 * while the engine isn't serving, so the caller can record the box as down.
 */
export async function repairServerMail(
  executor: CommandExecutor,
  opts: { onLog: (log: SystemLog) => void },
): Promise<{ started: boolean; mailDown: boolean; reason?: string }> {
  const warn = (message: string) =>
    opts.onLog({ timestamp: new Date().toISOString(), level: "warn", message });

  const probe = await detectMailEngine(executor).catch(() => null);

  if (!probe || probe.flavor === "none") {
    // Separate "no engine here" from "we couldn't look": with Docker unreachable
    // the container probe can't conclude, and blaming mail setup would be wrong.
    const docker = await dockerAvailable(executor).catch(() => false);
    const reason = docker
      ? "There is no mail engine on this server — run mail setup on it first."
      : "Docker isn't available on this server, so the mail engine can't be started.";
    warn(reason);
    return { started: false, mailDown: true, reason };
  }

  if (probe.running) {
    opts.onLog({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "The mail engine is already running — nothing to start.",
    });
    return { started: false, mailDown: false };
  }

  try {
    const result =
      probe.flavor === "host"
        ? await startHostMail(executor, { onLog: opts.onLog })
        : await startContainerMail(executor, { onLog: opts.onLog });
    if (!result.started) {
      if (result.reason) warn(result.reason);
      return { started: false, mailDown: true, reason: result.reason };
    }
    return { started: true, mailDown: false };
  } catch (err) {
    const reason = safeErrorMessage(err);
    warn(`Could not start the mail engine (${reason}).`);
    return { started: false, mailDown: true, reason };
  }
}
