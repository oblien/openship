/**
 * "This Server" — the box's own deploy-target row. Self-hosted (server-host /
 * "VPS") only.
 *
 * When OpenShip runs ON a server, the host is itself a deployable target, so it
 * gets exactly ONE `isLocal` row, owned by the box org (`boxOwningOrgId`). Deploys
 * to it resolve to the pooled HOST channel (`sshManager.acquireHostChannel`), not to
 * a per-row SSH dial — see `deployment-runtime.acquireLocalHostExecutor`.
 *
 * {@link ensureLocalServer} is the ONLY place that row is created, and
 * {@link findLocalServer} is how a hot path asks whether it exists. It states an
 * invariant about the MACHINE — never about a domain, an install method, or which
 * branch of the admin bootstrap happened to run. That coupling is exactly what
 * broke: the row used to be written only in the tail of a SUCCESSFUL
 * bootstrap-admin, so on the free-domain install (which connects Openship Cloud
 * FIRST, and cloud-connect mirrors the cloud user into a real admin) bootstrap-admin
 * answered 409 "already exists", the CLI fell back to reset-admin-password, and the
 * box had no server row until the API next restarted. A custom domain connects
 * nothing, so it registered fine — which made the bug read as "the free domain
 * skips server registration".
 *
 * So every path that can make the invariant satisfiable calls it: the boot hook,
 * each admin-establishing endpoint (bootstrap-admin / reset-admin-password /
 * cloud-connect), and the servers read path, which self-heals.
 *
 * Atomic in both senses: concurrent callers cannot produce two rows (single-flight
 * below), and there is no half-registered state — a caller gets the one canonical
 * row, or null with a logged reason.
 *
 * The row's EXISTENCE and its host-channel HEALTH are separate questions, and this
 * module answers both without conflating them (#509). Only the explicit
 * `--no-host-control` opt-out withholds the row: that is a policy saying this box is
 * not a target. A channel that was never provisioned, or one a firewall drops, is not
 * — the workload is reached through the mounted Docker socket, so ordinary deploys to
 * this box work and hiding the row would break them. What was missing is that nothing
 * WARNED either: the wizard offered "This Server" and the first host-side step failed
 * mid-deploy. So {@link localServerHostChannel} reports the channel for the row, for
 * the target list and the deploy wizard to surface — an annotation, never a gate.
 */
import { env } from "../../config/env";
import type { HostChannelCode } from "@repo/adapters";
import { repos, type Server } from "@repo/db";
import { boxOwningOrgId } from "../box-org";
import { resolvePlatformConfig } from "../controller-helpers";
import { resolveInstancePublicIp } from "../server-target";
import { registerStartupHook } from "./index";

export type EnsureLocalServerOptions = {
  /** Row name when it has to be created. Defaults to "This Server". */
  name?: string;
  /** Display address when it has to be created. Detected when omitted. */
  sshHost?: string;
};

/** The in-flight registration, shared by every concurrent caller. */
let inFlight: Promise<Server | null> | null = null;

/**
 * Ensure this host has its canonical `isLocal` deploy-target row. Returns the row,
 * or null when this box isn't a deploy target (SaaS/desktop, host control off) or
 * can't own one yet (no founding admin). Safe to call from any phase, on any path,
 * as often as you like.
 *
 * Single-flight: the boot hook, an admin-establishing endpoint and a `GET /servers`
 * can all land in the same tick on a fresh box, and "findLocal then create" is a
 * read-modify-write — without this each would see "no row" and insert its own.
 * One API process owns the DB (bare = one supervised process, compose = one api
 * container), so serializing here IS the mutual exclusion; no advisory lock needed.
 * The promise is dropped once it settles, so a later call re-checks the DB — the
 * row is re-created if it's ever deleted.
 */
export async function ensureLocalServer(opts?: EnsureLocalServerOptions): Promise<Server | null> {
  if (!inFlight) {
    inFlight = register(opts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * Who may own this box's row, or null when nobody can yet.
 *
 * Shared by the reader and the writer so they cannot disagree about whether this box
 * has a row: a reader with a laxer gate would answer for a machine that is not a
 * deploy target, and one with a stricter gate would report "no row" for a row that
 * plainly exists.
 */
async function localServerOwnerOrg(): Promise<string | null> {
  // No row where this box can't be a picked deploy target: the SaaS control plane
  // never is, and desktop deploys to its own machine by DERIVING it (no cloud
  // workspace + no serverId = "here", see project.ts) rather than through a row.
  // Callers must handle the null: `resolveTargetPlatform`'s derived-local branch
  // takes the pooled host channel, which is the same box either way.
  //
  // Gated HERE rather than only on the boot hook's `modes`, because the read/write
  // paths below call this directly.
  if (resolvePlatformConfig().target !== "selfhosted") return null;

  // Host control off → this box is NOT a deploy target, so don't advertise it as
  // one. Registering it would put a server in the list whose every operation
  // throws, which reads as broken rather than as a policy. (`listServers` hides
  // isLocal rows under the same flag, so this stays consistent either way.)
  const { hostControlDisabled } = await import("@repo/adapters");
  if (hostControlDisabled()) return null;

  // The row is owned by the box org (the founding admin's personal org), so it
  // can't exist before that admin does. Every call site is a retry of this gate:
  // on a CLI install the API boots — and the hook runs — before the admin exists.
  return boxOwningOrgId();
}

/**
 * READ this box's canonical row. Never creates one, never dials anything.
 *
 * For callers that need the row's identity on a hot path — `resolveTargetPlatform`
 * runs per deploy and per runtime read, and only wants the id. Those must not call
 * {@link ensureLocalServer}: creating on a resolve makes a deploy responsible for
 * registering a server, and drags the creation path's public-IP detection (an
 * outbound request) onto every resolve on a box whose row is missing. Registration
 * belongs to the paths that ARE preparation — the boot hook, the admin-establishing
 * endpoints, and the servers read path that self-heals.
 */
export async function findLocalServer(): Promise<Server | null> {
  const organizationId = await localServerOwnerOrg();
  if (!organizationId) return null;
  return (await repos.server.findLocal(organizationId)) ?? null;
}

async function register(opts?: EnsureLocalServerOptions): Promise<Server | null> {
  const organizationId = await localServerOwnerOrg();
  if (!organizationId) return null;

  // The account the host channel actually logs in as. The CLI writes
  // OPENSHIP_HOST_SSH_USER when it provisions the container→host channel; the default
  // matches `hostChannelUser()`, so a bare install with no channel agrees too. A row
  // claiming `root` while the channel dials someone else is issue #489 — and since
  // these fields are display-only (below), nothing else would ever correct it.
  const desiredSshUser = process.env.OPENSHIP_HOST_SSH_USER?.trim() || "root";

  const existing = await repos.server.findLocal(organizationId);
  if (existing) {
    // Reconciled on every path that calls this, not only at boot — the `GET /servers`
    // self-heal included. `?? "root"` normalizes a legacy null so an old row doesn't
    // re-issue the write on every read. Best-effort (a display value never blocks the
    // caller), but never silent: a swallowed failure would leave us reporting a value
    // we never persisted, re-attempting forever with nothing in the log.
    if ((existing.sshUser ?? "root") !== desiredSshUser) {
      repos.server
        .update(existing.id, { sshUser: desiredSshUser })
        .then(() =>
          console.log(
            `[self-server] reconciled ssh_user → ${desiredSshUser} (matches host channel)`,
          ),
        )
        .catch((err: unknown) => console.warn("[self-server] ssh_user reconcile failed:", err));
      return { ...existing, sshUser: desiredSshUser };
    }
    return existing;
  }

  // ssh* fields are display-only for an isLocal row (never dialed). Prefer a real
  // address so the servers list reads truthfully AND the DNS A record for a domain
  // deployed here points at the box's public IP rather than loopback. Detected
  // once, here at "ensure this server" — never on a per-request path.
  const sshHost =
    opts?.sshHost?.trim() ||
    env.SERVER_IP ||
    env.HOST_DOMAIN ||
    (await resolveInstancePublicIp()) ||
    "127.0.0.1";
  const row = await repos.server.create({
    organizationId,
    name: opts?.name?.trim() || "This Server",
    sshHost,
    sshUser: desiredSshUser,
    isLocal: true,
  });
  console.log(
    `[self-server] registered this host as a deploy target (${sshHost}, ssh_user=${desiredSshUser})`,
  );
  return row;
}

/** The container→host channel behind a local row's host-side steps. */
export interface LocalServerHostChannel {
  /**
   * Host ("this machine") operations work.
   *
   * Derived from `channel`, NOT from reachability: a `disabled` row is deliberately
   * REACHABLE (its containers deploy over the Docker socket) while every host-side
   * step refuses, and those are different questions. This one is "will the host-side
   * steps of a deploy to this row run".
   */
  ok: boolean;
  /** Which host-channel state, in `hostChannelHealth`'s own vocabulary. */
  channel: HostChannelCode;
  /** Operator-facing remedy, when there is one — the same string this row's own
   *  reachability endpoint returns. One wording, one source. */
  hint: string | null;
}

/**
 * The host-channel state to show ON a server row, or null when the row has no channel
 * to report (a remote box, or a diagnosis that couldn't run).
 *
 * Goes through `sshManager.diagnoseReachability` rather than probing here, so a row's
 * badge in the list and its own reachability endpoint cannot disagree — that kind of
 * divergence is what had the dashboard reporting the wrong machine (#490). It also
 * inherits the circuit breaker, so a dead channel costs a remembered reason instead of
 * a probe timeout per list render.
 *
 * Safe to call for ANY row: `channel` is only ever set for a row that resolves to this
 * box, so a remote row answers null instead of being labelled with our channel.
 */
export async function localServerHostChannel(
  serverId: string,
): Promise<LocalServerHostChannel | null> {
  // Dynamic, like `hostControlDisabled` in `register()`: this file runs on the boot
  // path and must not drag the SSH stack in before anything asks it a question.
  const { sshManager } = await import("../ssh-manager");
  const d = await sshManager.diagnoseReachability(serverId).catch(() => null);
  if (!d?.channel) return null;
  return {
    ok: d.channel === "ok" || d.channel === "not_applicable",
    channel: d.channel,
    hint: d.hint ?? null,
  };
}

export function registerSelfServerReconcile(): void {
  registerStartupHook({
    id: "self-server:reconcile",
    // "selfhosted" excludes desktop (resolvePlatformConfig maps desktop →
    // "desktop"), so this only runs on a real server-host install.
    modes: ["selfhosted"],
    run: async () => {
      await ensureLocalServer();
    },
  });
}
