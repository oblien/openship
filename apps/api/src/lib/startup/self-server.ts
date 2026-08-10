/**
 * "This Server" — the box's own deploy-target row. Self-hosted (server-host /
 * "VPS") only.
 *
 * When OpenShip runs ON a server, the host is itself a deployable target, so it
 * gets exactly ONE `isLocal` row, owned by the box org (`boxOwningOrgId`). Deploys
 * to it resolve to the LOCAL host executor (createHostExecutor), not SSH — see
 * `deployment-runtime.resolveServerExecutor`.
 *
 * {@link ensureLocalServer} is the ONLY place that row is created. It states an
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
 */
import { env } from "../../config/env";
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

async function register(opts?: EnsureLocalServerOptions): Promise<Server | null> {
  // Not a deploy target at all: the SaaS control plane never is, and desktop
  // targets its own machine through its own "This Machine" row. Gated HERE rather
  // than only on the boot hook's `modes`, because the read/write paths below call
  // this directly.
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
  const organizationId = await boxOwningOrgId();
  if (!organizationId) return null;

  const existing = await repos.server.findLocal(organizationId);
  if (existing) return existing;

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
    isLocal: true,
  });
  console.log(`[self-server] registered this host as a deploy target (${sshHost})`);
  return row;
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
