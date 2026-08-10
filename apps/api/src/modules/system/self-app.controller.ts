/**
 * Self-registration of the control plane as a managed "app".
 *
 * The CLI setup wizard calls these AFTER bootstrap-admin (internal-token gated,
 * self-hosted only). They reuse the ordinary app + domain pipes so that, once
 * setup finishes, Openship itself shows up under the dashboard's **Apps** tab
 * with a real domain:
 *   - createProject({ isApp:true, appTemplateId:"openship" })  → the Apps row
 *   - free  domain → Cloud edge proxy (slug.opsh.io → this box) through
 *     ensureManagedEdgeProxy, the same funnel a deployed app's free subdomain uses
 *     (which is also what proves this box controls the target) — needs the owner
 *     connected to Openship Cloud
 *   - custom domain → OpenResty + Let's Encrypt via provisionSelfEdge, streamed
 *     live through a setup-session for the wizard's spinner
 *
 * No new routing/SSL machinery — Openship deploys itself with its own tools.
 */

import type { Context } from "hono";
import type { ImportedSite, ManualCert } from "@repo/adapters";
import { repos, db, schema, eq } from "@repo/db";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { sshManager } from "../../lib/ssh-manager";
import { env } from "../../config";
import { assertNotCloud, platform } from "../../lib/controller-helpers";
import { ensureLocalUser } from "../../lib/local-user";
import { createProject } from "../projects/project-crud.service";
import { getCloudConnectionStatusForOrg } from "../../lib/cloud/session";
import { ensureManagedEdgeProxy, ManagedEdgeError } from "../../lib/managed-edge-proxy";
import { ensureAdoptDeployment, provisionSelfAppEdge } from "../../lib/startup/self-deploy";
import { ensureLocalServer } from "../../lib/startup/self-server";
import { reapplyProjectLiveRoutes } from "../domains/project-route.service";
import { refreshSelfAppPublicUrl } from "../../lib/public-url";
import { streamSSE } from "../../lib/sse";
import {
  createSetupSession,
  getSetupSession,
  updateComponentProgress,
  appendSetupLog,
  finishSetupSession,
  subscribeSetupSession,
} from "./setup-session";

const APP_SLUG = "openship";
const APP_TEMPLATE_ID = "openship";

/**
 * The org that OWNS this box. Once connected to Openship Cloud, the mirrored
 * cloud user is the admin and its personal org `org_<id>` carries the cloud
 * link — prefer that. Otherwise fall back to the deterministic local owner
 * (fresh / self-hosted-only box). Single source of truth so cloud-status and
 * self-register act on the SAME org after a cloud connect — no client-side org
 * threading needed.
 */
/**
 * The founding admin's user id — the earliest real (non-auto-provisioned) account.
 * bootstrap-admin RENAMES the local user off LOCAL_EMAIL, so ensureLocalUser()'s
 * email lookup misses it and provisions a PHANTOM user + org the admin can't see.
 * Query the admin row directly to avoid that. Returns null on a box with no admin.
 */
export async function foundingAdminId(): Promise<string | null> {
  const [admin] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.autoProvisioned, false))
    .orderBy(schema.user.createdAt)
    .limit(1);
  return admin?.id ?? null;
}

async function resolveOrg(): Promise<{ userId: string; organizationId: string }> {
  const linked = await repos.settings.listCloudLinkedOrgIds().catch(() => [] as string[]);
  if (linked.length > 0) {
    const organizationId = linked[0];
    return { userId: organizationId.replace(/^org_/, ""), organizationId };
  }
  // Prefer the founding admin's personal org — that's the org the dashboard
  // session is scoped to, so the control-plane app lands where the admin sees it.
  // ensureLocalUser is only the last resort (a box with no admin yet).
  const adminId = await foundingAdminId();
  if (adminId) return { userId: adminId, organizationId: `org_${adminId}` };
  const localUser = await ensureLocalUser();
  return { userId: localUser.id, organizationId: `org_${localUser.id}` };
}

/** Find-or-create the control-plane app project (idempotent). Returns its id. */
async function ensureControlPlaneApp(organizationId: string, port?: number): Promise<string> {
  const existing = await repos.project.findBySlugInOrg(organizationId, APP_SLUG);
  if (existing) return existing.id;
  const created = await createProject(
    {
      name: "Openship",
      isApp: true,
      appTemplateId: APP_TEMPLATE_ID,
      hasBuild: false,
      hasServer: true,
      projectType: "app",
      ...(port ? { port } : {}),
    },
    organizationId,
  );
  return created.id;
}

/**
 * GET /api/system/cloud-status — is the org's owner connected to Openship Cloud?
 * The wizard checks this before offering / after driving the free-domain path.
 */
export async function cloudStatus(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const { organizationId } = await resolveOrg();
  const status = await getCloudConnectionStatusForOrg(organizationId);
  return c.json(status);
}

/**
 * POST /api/system/cloud-connect — finalize the browser PKCE handshake AND make
 * the Openship Cloud account this box's admin, reusing the EXACT desktop
 * identity pipe (no duplication): `mirrorCloudUser` provisions a local user from
 * the cloud identity (+ its personal org + owner membership), we store the cloud
 * session against it, and switch the box to `authMode="cloud"` so the local
 * login offers "Continue with Cloud" — passwordless, no separate local
 * credential. Internal-token gated (the fresh wizard has no session/PAT).
 */
export async function cloudConnect(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const body = await c.req
    .json<{ code?: string; codeVerifier?: string }>()
    .catch(() => ({}) as { code?: string; codeVerifier?: string });
  if (!body.code) return c.json({ error: "code is required" }, 400);

  try {
    const { exchangeCodeWithCloud, mirrorCloudUser, storeCloudSession } = await import(
      "../../lib/cloud-auth-proxy"
    );
    const { clearAuthModeCache, isAuthModePinned } = await import("../../lib/auth-mode");
    const data = await exchangeCodeWithCloud(body.code, body.codeVerifier);
    if (!data) return c.json({ error: "Could not verify with Openship Cloud" }, 401);
    const email = (data.user as { email?: string | null }).email ?? null;

    // If this box ALREADY has a real local admin account, Openship Cloud is linked
    // for SERVICES ONLY — the free .opsh.io domain and managed mail. Store the cloud
    // session against the existing owner so the edge-proxy has a token, and DO NOT
    // change the login method. Only a fresh box with NO local admin (the free-domain
    // wizard path) adopts cloud as its passwordless link-based login. Keying off a
    // real admin ROW (not the authMode string) is what makes the free path — which
    // has no admin yet — correctly fall through to cloud login.
    const adminId = await foundingAdminId();
    if (adminId) {
      // Bind against the ACTUAL admin (its personal org is org_<id>). foundingAdminId
      // queries the admin row directly — NOT resolveOrg()/ensureLocalUser(), which
      // would miss the renamed local user and provision a phantom org.
      await storeCloudSession(adminId, data.sessionToken);
      await ensureLocalServer().catch(() => {});
      return c.json({
        ok: true,
        userId: adminId,
        organizationId: `org_${adminId}`,
        email,
        linked: "services",
      });
    }

    const userId = await mirrorCloudUser(data.user);
    await storeCloudSession(userId, data.sessionToken);
    // The mirror just made this box's founding admin, so its "This Server" row is
    // now registerable — and this is the EARLIEST point on the free-domain install
    // where that's true (bootstrap-admin will 409 on the very admin created here).
    await ensureLocalServer().catch(() => {});
    // Fresh box → local login becomes cloud-backed (passwordless). Reuse the
    // singleton upsert; clear the cached mode so the change takes effect now.
    //
    // Skipped when the launcher DECLARED the mode (OPENSHIP_AUTH_MODE). This line
    // is where the desktop bug came from: desktop has no local admin by design
    // (zero-auth auto-provisions), so foundingAdminId() returns null and every
    // "connect Openship Cloud" from Settings fell through to here and converted a
    // loopback-only app to remote login — with no way back short of wiping the
    // local DB. Linking a cloud account must not change how you log in to a box
    // whose login method was declared at launch.
    if (!isAuthModePinned()) {
      await repos.instanceSettings.upsert({ authMode: "cloud" });
      clearAuthModeCache();
    }
    return c.json({ ok: true, userId, organizationId: `org_${userId}`, email });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/**
 * POST /api/system/self-register — register the control plane as an app and
 * attach its domain. Free returns immediately; custom returns a `sessionId` to
 * stream provisioning progress from.
 */
export async function selfRegister(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const body = await c.req.json<{
    domainType?: "free" | "custom" | "byo";
    hostname?: string;
    slug?: string;
    dashPort?: number;
    acmeEmail?: string;
    publicHost?: string;
    /** User accepted taking over ports 80/443 from an existing proxy. */
    edgeTakeover?: boolean;
    /** User accepted migrating the existing proxy's sites before taking over. */
    edgeMigrate?: boolean;
    /** Corrected static roots (keyed by primary hostname) the wizard copied into
     *  the edge's static bind mount host-side, for adopted static sites the
     *  container edge couldn't otherwise reach. See #456. */
    staticRootOverrides?: Record<string, string>;
    /** Bare install: stand up a LOCAL host edge (OpenResty on :80) on this box.
     *  A free domain's Cloud edge forwards to :80 here, so the box needs the
     *  vhost + the same foreign-proxy takeover a custom domain does — just no
     *  cert (Cloud terminates TLS). In compose the container edge owns :80, so
     *  this is omitted and only the route is registered. */
    localEdge?: boolean;
  }>().catch(() => ({}) as Record<string, never>);

  const domainType = body.domainType ?? "byo";
  const dashPort = Number(body.dashPort) || env.OPENSHIP_DASHBOARD_PORT || 3001;
  const { organizationId } = await resolveOrg();
  const projectId = await ensureControlPlaneApp(organizationId, dashPort);

  // Make the control plane a REAL deployment (adopt the already-running process)
  // so the Domains tab / runtime / routing are owned by the normal pipeline. Must
  // run BEFORE any route work — reapplyProjectLiveRoutes needs activeDeploymentId.
  await ensureAdoptDeployment(projectId, dashPort);

  if (domainType === "free") {
    const slug = (body.slug ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return c.json({ error: "slug is required for a free domain" }, 400);
    const hostname = `${slug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}`;
    // THE shared funnel — `ensureManagedEdgeProxy`, the same call a deployed app's
    // free subdomain goes through, with the operator's `--public-url` host passed as
    // a target candidate. This path used to resolve the target and post to the SaaS
    // itself; that bypass is now load-bearing to close, because Openship Cloud
    // refuses to route to an unproven target and the verify-and-retry lives in the
    // funnel. A wizard with its own copy would 403 with nothing to explain it.
    //
    // NOT `:${dashPort}`: pointing Cloud straight at :3001 meant the free domain
    // only worked with that port open to the internet, put the dashboard on a
    // public port in plain HTTP (bypassable — anyone hitting <ip>:3001 skipped the
    // edge, its TLS, rate limits and rules), and left the local edge with no vhost
    // for the hostname at all, so every request fell to default_server. Now the box
    // needs nothing but :80/:443, and a free domain routes exactly like a custom
    // one: through the edge, matched on Host, to the dashboard on loopback.
    let host: string;
    let targetWarning: string | undefined;
    try {
      const wired = await ensureManagedEdgeProxy(organizationId, slug, {
        preferHost: body.publicHost,
      });
      host = wired.target;
      targetWarning = wired.warning;
    } catch (err) {
      // The funnel's own status: 400 unresolvable target, 409 Cloud not linked,
      // 502 upstream refusal. Preserved rather than collapsed — the wizard shows
      // this straight to the operator and each one has a different fix.
      const status = err instanceof ManagedEdgeError ? err.status : 502;
      return c.json({ error: safeErrorMessage(err) }, status);
    }
    // Reported back with the result: the target decides whether this URL serves,
    // and `warning` is set when it's a hostname rather than this box's IP.
    const edgeNote = targetWarning ? `${hostname} is ${targetWarning}` : undefined;
    // Oblien's edge terminates TLS for *.opsh.io, so the domain is secured the
    // moment the proxy syncs — but it forwards to :80 here, which is OUR edge, so
    // the edge also needs a vhost for this hostname or every request lands on
    // default_server and 404s.
    await repos.domain.findOrCreate({
      projectId,
      hostname,
      domainType: "free",
      isPrimary: true,
      verified: true,
      verifiedAt: new Date(),
      status: "active",
      sslStatus: "active",
    });
    // Bare install: Cloud forwards to :80 on THIS box, so it needs a local edge
    // (OpenResty) listening there — and if a foreign proxy already holds :80, the
    // same takeover/migrate a custom domain runs. This is the SAME provisioner,
    // minus the cert (Cloud terminates TLS). Streamed like the custom path so the
    // wizard shows install/takeover progress. Skipping this is exactly why a bare
    // free box with a foreign proxy on :80 resolved and then 404'd.
    if (body.localEdge) {
      const session = createSetupSession(
        [
          { name: "edge", label: "Install the edge (80/443)" },
          { name: "route", label: "Route domain to Openship" },
        ],
        "self",
      );
      void provisionSelfAppEdge(
        projectId,
        hostname,
        dashPort,
        {
          onLog: (message, level) => appendSetupLog(session.id, "edge", message, level),
          onStep: (step, status) => updateComponentProgress(session.id, step, status),
        },
        // No cert step: the row above is `domainType: "free"`, so both the
        // provisioner and manageDomainSsl skip issuance (tlsIssuedElsewhere) —
        // Cloud terminates TLS for *.opsh.io. And no managed-edge sync:
        // `ensureManagedEdgeProxy` above already did it (and verified the target if
        // Cloud asked), so a second one would only race its own token.
        {
          edgeTakeover: body.edgeTakeover === true,
          edgeMigrate: body.edgeMigrate === true,
          ...(body.staticRootOverrides ? { staticRootOverrides: body.staticRootOverrides } : {}),
          managedEdgeSyncedByCaller: true,
        },
      )
        .then(async (res) => {
          await refreshSelfAppPublicUrl().catch(() => {});
          finishSetupSession(session.id, res.verified ? "completed" : "failed");
        })
        .catch((err) => {
          appendSetupLog(session.id, "edge", safeErrorMessage(err), "error");
          finishSetupSession(session.id, "failed");
        });
      return c.json({
        ok: true,
        url: `https://${hostname}`,
        hostname,
        sessionId: session.id,
        target: host,
        ...(edgeNote ? { warning: edgeNote } : {}),
      });
    }

    // Compose (the container edge owns :80) or no host edge: just register the
    // LOCAL route (plain :80 vhost — Cloud already terminated TLS). Best-effort
    // like every routing step, but logged loudly: without it the domain resolves
    // and then 404s, indistinguishable from a DNS problem to the operator.
    const freshFree = await repos.project.findById(projectId);
    if (freshFree) {
      // `managedEdgeSyncedByCaller`: `ensureManagedEdgeProxy` above already registered
      // this slug on Cloud's edge (and verified the target if it had to). With
      // `previousHostnames` empty the re-apply would treat the row we just created as
      // newly added and sync it a second time — a duplicate challenge for the same
      // target, where the loser's check fails against a token the winner reset.
      await reapplyProjectLiveRoutes(freshFree, [], {
        isSelfApp: true,
        managedEdgeSyncedByCaller: true,
      }).catch((err) =>
        console.warn(
          `[self-register] free domain ${hostname} registered with Cloud but the local edge route failed: ${safeErrorMessage(err)}`,
        ),
      );
    }
    await refreshSelfAppPublicUrl().catch(() => {});
    return c.json({
      ok: true,
      url: `https://${hostname}`,
      hostname,
      target: host,
      ...(edgeNote ? { warning: edgeNote } : {}),
    });
  }

  if (domainType === "custom") {
    const hostname = (body.hostname ?? "").trim().toLowerCase();
    if (!hostname || !hostname.includes(".")) {
      return c.json({ error: "a valid hostname is required for a custom domain" }, 400);
    }
    // verified:true — we assert control via ACME HTTP-01 (not A-record; SERVER_IP
    // isn't set under `openship up`), and manageDomainSsl gates cert issuance on
    // the verified flag. Route registration doesn't depend on status.
    await repos.domain.findOrCreate({
      projectId,
      hostname,
      domainType: "custom",
      isPrimary: true,
      verified: true,
      verifiedAt: new Date(),
      status: "pending",
      sslStatus: "provisioning",
    });

    const session = createSetupSession(
      [
        { name: "edge", label: "Install the edge" },
        { name: "route", label: "Route domain to Openship" },
        { name: "ssl", label: "Issue SSL certificate" },
      ],
      "self",
    );

    // Drive edge provisioning in the background; the wizard streams progress.
    // Routing + cert flow through the normal pipeline (reapplyProjectLiveRoutes +
    // manageDomainSsl) — this only installs toolchain + takes over 80/443.
    void provisionSelfAppEdge(
      projectId,
      hostname,
      dashPort,
      {
        backoffs: [15_000, 45_000], // shorter than the boot hook so the spinner resolves
        onLog: (message, level) => appendSetupLog(session.id, "edge", message, level),
        onStep: (step, status) => updateComponentProgress(session.id, step, status),
      },
      {
        edgeTakeover: body.edgeTakeover === true,
        edgeMigrate: body.edgeMigrate === true,
        ...(body.staticRootOverrides ? { staticRootOverrides: body.staticRootOverrides } : {}),
      },
    )
      .then(async (res) => {
        await repos.domain
          .updateSsl(await domainIdFor(projectId, hostname), {
            sslStatus: res.verified ? "active" : "error",
            sslExpiresAt: res.expiresAt ? new Date(res.expiresAt) : undefined,
          })
          .catch(() => {});
        await refreshSelfAppPublicUrl().catch(() => {});
        finishSetupSession(session.id, res.verified ? "completed" : "failed");
      })
      .catch((err) => {
        appendSetupLog(session.id, "edge", safeErrorMessage(err), "error");
        finishSetupSession(session.id, "failed");
      });

    return c.json({ ok: true, sessionId: session.id, url: `https://${hostname}`, hostname });
  }

  // BYO reverse proxy — record the domain, provision nothing.
  const hostname = (body.hostname ?? "").trim().toLowerCase();
  if (hostname) {
    await repos.domain.findOrCreate({
      projectId,
      hostname,
      domainType: "custom",
      isPrimary: true,
      externalIngress: true,
      verified: true,
      verifiedAt: new Date(),
      status: "active",
      sslStatus: "external",
    });
  }
  await refreshSelfAppPublicUrl().catch(() => {});
  return c.json({ ok: true, url: hostname ? `https://${hostname}` : null, hostname: hostname || null });
}

/**
 * POST /api/system/self-edge/preflight — detect what owns ports 80/443 on THIS
 * machine before the wizard installs OpenResty (internal-token gated, local
 * executor). Read-only; the CLI uses it to prompt migrate/takeover/cancel.
 */
export async function selfEdgePreflight(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;

  // Managed edge only installs on a Linux host; elsewhere there's nothing to take over.
  if (process.platform !== "linux") {
    return c.json({ status: { classification: "free", occupants: [], canProceedClean: true } });
  }

  try {
    const { detectEdge, importSites, unreachableStaticRoots, dockerAvailable } =
      await import("@repo/adapters");
    // Host-op executor: LocalExecutor bare, SSH→host.docker.internal when
    // containerized (OPENSHIP_HOST_SSH_* set). Inspecting the api container's
    // own netns would return a wrong migrate/takeover prompt in docker mode.
    // Pooled — this endpoint is polled by the CLI/wizard, and a per-call executor
    // is what leaked sshd sessions until OOM (#291).
    const { status, sites, warnings, containerEdge } = await sshManager.withHostExecutor(
      async (executor) => {
        const detected = await detectEdge(executor);
        // Scan the foreign proxy's sites (if importable) so the CLI can offer migration.
        const scanned = await importSites(executor, detected);
        // Whether the edge that WILL serve these sites is a container. `docker` mode
        // is the obvious yes; but the bare wizard also installs a CONTAINER edge on any
        // Docker-equipped host, and keying only on OPENSHIP_EDGE_MODE hid the unreachable
        // roots from exactly that path — so OR in a live Docker probe (#456).
        const containerEdge =
          process.env.OPENSHIP_EDGE_MODE === "docker" || (await dockerAvailable(executor));
        return { status: detected, sites: scanned.sites, warnings: scanned.warnings, containerEdge };
      },
    );
    // Identify static sites whose docroot is outside the edge container's bind
    // mounts — migrating them verbatim produces a 500 (try_files can't find the
    // index in a directory that isn't mounted). Surfacing this BEFORE cutover
    // lets the wizard prompt the operator to copy/mount/skip each path.
    const unreachable = unreachableStaticRoots(sites, { containerEdge });
    return c.json({ status, sites, warnings, unreachableStaticRoots: unreachable });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/**
 * POST /api/system/edge/import-sites — register sites parsed from a foreign proxy
 * as routes on THIS box's CONTAINER edge (internal-token gated, docker-edge mode).
 *
 * `openship up` (compose) detects + stops the foreign proxy on the HOST and parses
 * its vhosts BEFORE `docker compose up` (the host-net edge container can't bind
 * :80/:443 otherwise, and it can't read the host filesystem). It then hands the
 * parsed sites here — plus any cert PEMs it read host-side (`certPems`, keyed by
 * the source cert path) — so we re-serve them through the container edge.
 *
 * No new routing machinery: we drive the SAME provider the deploy pipeline uses,
 * resolved from the local platform (a `NginxProvider` on the `DockerEdgeExecutor`
 * when `OPENSHIP_EDGE_MODE=docker`), via the shared `registerImportedSites`.
 */
export async function edgeImportSites(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;

  let body: { sites?: unknown; certPems?: unknown; staticRootOverrides?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.sites)) return c.json({ error: "`sites` must be an array" }, 400);
  const sites = body.sites as ImportedSite[];
  if (sites.length === 0) return c.json({ registered: [], warnings: [] });

  const certPems =
    body.certPems && typeof body.certPems === "object"
      ? (body.certPems as Record<string, ManualCert>)
      : undefined;
  // Corrected static roots the CLI copied host-side before `docker compose up`
  // (the container edge can't read the host source dir itself). See #456.
  const staticRootOverrides =
    body.staticRootOverrides && typeof body.staticRootOverrides === "object"
      ? (body.staticRootOverrides as Record<string, string>)
      : undefined;

  try {
    const { registerImportedSites } = await import("@repo/adapters");
    const p = platform();
    if (!p.executor) return c.json({ error: "This instance has no local edge to import into" }, 400);
    const warnings: string[] = [];
    const registered = await registerImportedSites(p.routing, p.ssl, p.executor, sites, {
      certPems,
      staticRootOverrides,
      warnings,
      onLog: (entry) => console.log(`[edge-import] ${entry.message}`),
    });
    return c.json({ registered, warnings });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/** Resolve a domain row id by (project, hostname) for the SSL status patch. */
async function domainIdFor(projectId: string, hostname: string): Promise<string> {
  const row = await repos.domain.findByHostnameForProject(projectId, hostname.toLowerCase());
  return row?.id ?? "";
}

/**
 * GET /api/system/self-register/stream?id=<sessionId> — SSE progress for the
 * custom-domain provisioning (mirrors the system-install stream, but
 * internal-token gated rather than server-permission gated).
 */
export async function selfRegisterStream(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const sessionId = c.req.query("id");
  const session = sessionId ? getSetupSession(sessionId) : null;
  if (!session) return c.json({ error: "No such session" }, 404);

  return streamSSE(c, async (sseStream) => {
    let closed = false;
    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success } = subscribeSetupSession(session.id, writer);
    if (!success || session.status !== "running") return;

    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (closed) {
          clearInterval(iv);
          resolve();
        }
      }, 1000);
      sseStream.onAbort(() => {
        closed = true;
        clearInterval(iv);
        resolve();
      });
    });
  });
}
