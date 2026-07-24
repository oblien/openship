/**
 * Self-registration of the control plane as a managed "app".
 *
 * The CLI setup wizard calls these AFTER bootstrap-admin (internal-token gated,
 * self-hosted only). They reuse the ordinary app + domain pipes so that, once
 * setup finishes, Openship itself shows up under the dashboard's **Apps** tab
 * with a real domain:
 *   - createProject({ isApp:true, appTemplateId:"openship" })  → the Apps row
 *   - free  domain → Oblien edge proxy (slug.opsh.io → this box), reusing
 *     cloudClient().edgeProxy.sync — needs the owner connected to Openship Cloud
 *   - custom domain → OpenResty + Let's Encrypt via provisionSelfEdge, streamed
 *     live through a setup-session for the wizard's spinner
 *
 * No new routing/SSL machinery — Openship deploys itself with its own tools.
 */

import type { Context } from "hono";
import { repos, db, schema, eq } from "@repo/db";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { env } from "../../config";
import { assertNotCloud } from "../../lib/controller-helpers";
import { ensureLocalUser } from "../../lib/local-user";
import { createProject } from "../projects/project-crud.service";
import { cloudClient } from "../../lib/cloud/client";
import { getCloudConnectionStatusForOrg } from "../../lib/cloud/session";
import { ensureAdoptDeployment, provisionSelfAppEdge } from "../../lib/startup/self-deploy";
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
    const { clearAuthModeCache } = await import("../../lib/auth-mode");
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
    // Fresh box → local login becomes cloud-backed (passwordless). Reuse the
    // singleton upsert; clear the cached mode so the change takes effect now.
    await repos.instanceSettings.upsert({ authMode: "cloud" });
    clearAuthModeCache();
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
    // Bare host/IP — strip any scheme/path the caller may have included.
    const host = (body.publicHost || env.SERVER_IP || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");
    if (!host) {
      return c.json({ error: "Could not resolve this server's public address for the edge proxy" }, 400);
    }
    // Oblien's edge validates `target` as a full URL (not `host:port`) and
    // terminates TLS itself, forwarding to the origin box over plain HTTP on the
    // dashboard port.
    const target = `http://${host}:${dashPort}`;
    try {
      const result = await cloudClient({ organizationId }).edgeProxy.sync({ slug, target });
      if (!result) {
        return c.json(
          { error: "Openship Cloud is not connected — connect it to use a free .opsh.io domain." },
          409,
        );
      }
    } catch (err) {
      return c.json({ error: safeErrorMessage(err) }, 502);
    }
    // Oblien's edge terminates TLS for *.opsh.io and forwards to the box, so the
    // domain is live + secured the moment the proxy syncs.
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
    await refreshSelfAppPublicUrl().catch(() => {});
    return c.json({ ok: true, url: `https://${hostname}`, hostname });
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
        { name: "openresty", label: "Install OpenResty + certbot" },
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
      { edgeTakeover: body.edgeTakeover === true, edgeMigrate: body.edgeMigrate === true },
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
    const { createHostExecutor, detectEdge, importSites } = await import("@repo/adapters");
    // Host-op executor: LocalExecutor bare, SSH→host.docker.internal when
    // containerized (OPENSHIP_HOST_SSH_* set). Inspecting the api container's
    // own netns would return a wrong migrate/takeover prompt in docker mode.
    const executor = createHostExecutor();
    const status = await detectEdge(executor);
    // Scan the foreign proxy's sites (if importable) so the CLI can offer migration.
    const { sites, warnings } = await importSites(executor, status);
    return c.json({ status, sites, warnings });
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
