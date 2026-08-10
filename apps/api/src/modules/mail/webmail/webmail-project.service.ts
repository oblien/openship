/**
 * Webmail-as-project bridge.
 *
 * Webmail ships through the SAME deploy pipeline every other project uses,
 * with two narrow divergences:
 *
 *   1. The source is a PRE-BUILT release directory at `apps/email/dist/`
 *      (produced by `bun run build` in `apps/email/`). The deploy just
 *      tar-ships that dir to the target. No build runs at deploy time.
 *      If the dist doesn't exist, the deploy fails fast with instructions
 *      to build it first.
 *
 *   2. Install / start commands target the release layout - `bun install`
 *      runs inside `server/` (where the runtime deps live), and start is
 *      `bun run server/src/main.ts` with `CLIENT_BUILD_DIR` pointing at
 *      the bundled `client/` next to it.
 *
 * Everything else - preflight, toolchain (bun), workspace transfer,
 * OpenResty vhost, Let's Encrypt cert, lifecycle hooks - is the standard
 * `createQueuedDeployment` → `startBuild` path. The bespoke 10-step
 * engine that used to live here is gone. The previous "build on the
 * target" flow is gone too - it OOM-killed small VPSes during the Vite
 * SSR pass; pre-building avoids that entirely.
 */
import { randomBytes, createHash } from "node:crypto";
import { repos, type Project } from "@repo/db";
import { safeErrorMessage, type ReleaseSource, type DeployTarget } from "@repo/core";
import { sshManager } from "../../../lib/ssh-manager";
import { decryptEnvMap } from "../../../lib/encryption";
import { assertResourceInOrg } from "../../../lib/controller-helpers";
import type { RequestContext } from "../../../lib/request-context";
import {
  apiRootPath,
  readApiVersion,
  resolveReleaseDist,
  type ReleaseDistSpec,
} from "../../../lib/release-resolver";
import {
  buildConfigSnapshot,
  createQueuedDeployment,
  encryptEnvVars,
  metaWithPrevious,
  resolveSnapshotTarget,
  runDeploymentPreflight,
  startBuild,
} from "../../deployments/build.service";
import * as settingsService from "../../settings/settings.service";
import {
  listProjectRouteRows,
  syncProjectRouteState,
} from "../../domains/project-route.service";
import {
  readState,
  mutateState,
  type MailWebmailState,
  type MailServerState,
} from "../mail-state";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_NAME = "Webmail";

/**
 * Persistent webmail state on the target. The standard pipeline wipes the
 * per-deploy workspace on every redeploy, so anything that must survive
 * (branding config, the SQLite session DB) lives under this dir instead.
 */
const REMOTE_PERSIST_DIR = "/var/lib/openship-webmail";
const REMOTE_BRANDING_DIR = `${REMOTE_PERSIST_DIR}/branding`;
const REMOTE_SQLITE_PATH = `${REMOTE_PERSIST_DIR}/zero.db`;

/** Internal port Zero binds to behind the OpenResty vhost the pipeline creates. */
const DEFAULT_INTERNAL_PORT = 4080;

/**
 * Webmail (Zero) release source. Same repo/tag as openship — mono-version —
 * but a distinct per-arch asset. The shared resolver (release-dist.ts) does
 * the actual 3-slot resolution + download; this only pins the spec.
 */
const WEBMAIL_SOURCE: ReleaseSource = {
  mode: "github",
  repo: "oblien/openship",
  assetTemplate: "openship-email-{tag}-linux-amd64.tar.gz",
};

function webmailDistSpec(): ReleaseDistSpec {
  return {
    name: "email",
    version: readApiVersion(),
    source: WEBMAIL_SOURCE,
    // Env override points at an apps/email/ checkout; dist/ lives underneath.
    envOverride: "MAIL_WEBMAIL_SOURCE_DIR",
    envOverrideSubdir: "dist",
    repoLocalPath: apiRootPath("..", "email", "dist"),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve (download on miss) the pre-built webmail dist directory. The
 * client reads its backend URL from `window.location.origin` at runtime,
 * so one dist deploys to any hostname unchanged.
 */
async function resolveWebmailDistDir(): Promise<string> {
  return (await resolveReleaseDist(webmailDistSpec())).dir;
}

function deriveAcmeEmail(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  const base = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  return `admin@${base}`;
}

/**
 * The only operational concern that doesn't fit in the standard pipeline:
 * a persistent branding dir outside the workspace. The pipeline wipes the
 * workspace on every redeploy; branding config has to live somewhere else.
 *
 * Bun itself is installed by `ensureToolchain` via the standard catalog
 * (webmail stack declares `requiredTools: ["bun"]`) - no bespoke install here.
 */
async function prepareTarget(serverId: string): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    await exec.mkdir(REMOTE_PERSIST_DIR);
    await exec.exec(`chmod 0750 ${REMOTE_PERSIST_DIR}`);
    await exec.mkdir(REMOTE_BRANDING_DIR);
    await exec.exec(`chmod 0750 ${REMOTE_BRANDING_DIR}`);
    // The runtime adapter (re-)chowns these to the sandbox user on every
    // deploy, but doing it here too means a fresh server has the dirs in
    // the right shape before the first deploy starts - no permission
    // shuffle mid-pipeline that the user might see scroll past.
  });
}

async function persistWebmailBlock(
  mailServerId: string,
  block: MailWebmailState,
): Promise<void> {
  await sshManager.withExecutor(mailServerId, async (exec) => {
    const result = await mutateState(exec, mailServerId, (s) => ({ ...s, webmail: block }));
    if (!result) {
      throw new Error(
        "Could not persist webmail state - mail state file is missing on the server.",
      );
    }
  });
}

/**
 * Read the existing webmail block (if any) so a redeploy can reuse the
 * branding token + session encryption key. Returns null on any failure -
 * the caller falls back to minting fresh secrets.
 */
async function readExistingWebmailBlock(
  mailServerId: string,
): Promise<{ block: MailWebmailState | null; installDomain: string | null }> {
  try {
    let block: MailWebmailState | null = null;
    let installDomain: string | null = null;
    await sshManager.withExecutor(mailServerId, async (exec) => {
      const state = await readState(exec);
      block = state?.webmail ?? null;
      installDomain = state?.domain ?? null;
    });
    return { block, installDomain };
  } catch {
    return { block: null, installDomain: null };
  }
}

/**
 * Flip the `installed` flag on the mail-state webmail block to true.
 * Called from the deployment success hook so a failed build never leaves
 * a stale "Open webmail" CTA. Returns silently if the block is missing
 * (the deploy didn't go through `startWebmailDeploy` - nothing to flip).
 *
 * For cloud deploys to the mail server's own `mail.<install>` subdomain
 * we ALSO register an OpenResty proxy route on the mail VPS that points
 * `mail.<install>` → the Opshcloud URL. Operators can't change DNS for
 * that subdomain (it's pinned to the mail VPS for IMAP/SMTP), so the
 * mail VPS proxies it for them.
 *
 * The mailServerId is derived from the project slug (`webmail-<id>`) -
 * the slug is the only piece of webmail context that survives into the
 * generic deployment lifecycle.
 */
export async function markWebmailInstalled(
  mailServerId: string,
  organizationId: string,
  deployedUrl?: string,
): Promise<void> {
  try {
    let needsProxy = false;
    let proxyHostname = "";
    let proxyUpstream = "";

    await sshManager.withExecutor(mailServerId, async (exec) => {
      await mutateState(exec, mailServerId, (state) => {
        if (!state.webmail) return state; // nothing to flip — leave as-is

        // Detect: was this deploy on Opshcloud, targeted at the mail server's
        // own mail.<install> subdomain? If so we'll register the proxy AFTER
        // the (locked) state write returns.
        const installDomain = state.domain;
        const wm = state.webmail;
        const isCloud = wm.target === "cloud";
        const isOwnMailSubdomain =
          !!installDomain && wm.hostname === `mail.${installDomain}`;
        needsProxy = isCloud && isOwnMailSubdomain && !!deployedUrl;

        if (needsProxy) {
          proxyHostname = wm.hostname;
          proxyUpstream = deployedUrl!;
        }

        return {
          ...state,
          webmail: {
            ...wm,
            installed: true,
            deployedAt: new Date().toISOString(),
            ...(deployedUrl ? { cloudUrl: isCloud ? deployedUrl : wm.cloudUrl } : {}),
          },
        };
      });
    });

    if (needsProxy) {
      await registerWebmailCloudProxy(mailServerId, proxyHostname, proxyUpstream, organizationId);
    }
  } catch (err) {
    console.warn(
      `[webmail] could not flip installed=true for ${mailServerId}: ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Register an OpenResty proxy on the mail VPS:
 *   `https://<hostname>` → `<cloudUrl>`
 *
 * Used only for the cloud-deploy-with-mail-subdomain case (mail.<install>
 * can't be repointed via DNS, so the mail VPS proxies on the operator's
 * behalf). For every other case the standard project-pipeline routing
 * already handled the hostname.
 *
 * Provisions a Let's Encrypt cert as part of the registration. Failures
 * are non-fatal here - the proxy can be retried by a redeploy.
 */
async function registerWebmailCloudProxy(
  mailServerId: string,
  hostname: string,
  cloudUrl: string,
  organizationId: string,
): Promise<void> {
  // resolveTargetPlatform gives us the mail VPS's openresty + ssl -
  // same platform that fronts IMAP/SMTP traffic for this hostname today.
  // org-scoped: resolveTargetPlatform verifies mailServerId ∈ org.
  const { resolveTargetPlatform } = await import("../../../lib/deployment-runtime");
  const platform = await resolveTargetPlatform("server", "bare", mailServerId, organizationId);

  await platform.routing.registerRoute({
    domain: hostname,
    tls: true,
    // We issue this host's cert right below, so the edge must keep a :443 listener
    // up meanwhile — a routed host with no TLS listener refuses the handshake
    // (Cloudflare 525, #308) and that also blocks the issuance itself.
    terminatesTlsLocally: true,
    targetUrl: cloudUrl,
  });
  // Provision a cert for the proxy hostname. The mail VPS already has
  // certs for IMAP/SMTP STARTTLS - this adds the HTTPS-on-:443 cert
  // for the webmail UI. Reuses the existing Let's Encrypt feature.
  await platform.ssl.provisionCert(hostname);
}

/**
 * Slug prefix for an EXTERNAL-backend webmail (BYO IMAP/SMTP — SES / custom).
 * These have NO mail server / no mail-state.json: they're a standalone Zero
 * client pointed at an arbitrary backend. Distinct prefix so the mail-state
 * lifecycle hooks (markWebmailInstalled / cleanupWebmailInstall) skip them.
 */
const EXTERNAL_SLUG_PREFIX = "webmail-ext-";

/**
 * Extract the mailServerId encoded in a `webmail-<id>` project slug, or null
 * when the slug isn't an iRedMail-backed webmail. External-backend webmail
 * (`webmail-ext-*`) returns null: there's no mail server to mutate, so the
 * mail-state success/teardown hooks cleanly no-op.
 */
export function mailServerIdFromWebmailSlug(slug: string): string | null {
  if (slug.startsWith(EXTERNAL_SLUG_PREFIX)) return null;
  const m = slug.match(/^webmail-(.+)$/);
  return m?.[1] ?? null;
}

/**
 * Webmail-specific teardown that the generic project cleanup doesn't cover:
 *
 *   - The persistent branding dir on the target host (it lives outside the
 *     deploy artifact dir, since the standard pipeline wipes the workspace
 *     on every redeploy - so the generic runtime.destroy never touches it).
 *   - The `webmail` block in mail-state.json on the mail VPS, so a future
 *     re-deploy starts fresh instead of inheriting a stale brandingToken
 *     or `installed=true` flag.
 *
 * Called from project-cleanup.service after the standard manifest cleanup
 * (containers, routes, artifacts) has finished. All failures are swallowed
 * - the project rows are already soft-deleted, so a failing branding-dir
 * remove can't strand the user; it just leaves /var/lib/openship-webmail
 * behind until the next deploy reuses it.
 */
export async function cleanupWebmailInstall(input: {
  mailServerId: string;
}): Promise<void> {
  // 1. Read the webmail block to find the target host (webmail may live on
  //    a separate server from the mail VPS) BEFORE we wipe the block.
  let targetServerId: string | null = null;
  try {
    await sshManager.withExecutor(input.mailServerId, async (exec) => {
      const state = await readState(exec);
      targetServerId = state?.webmail?.targetServerId ?? null;
    });
  } catch (err) {
    console.warn(
      `[webmail] could not read mail-state on ${input.mailServerId}: ${safeErrorMessage(err)}`,
    );
  }

  // 2. Wipe the persistent branding dir on the target host.
  if (targetServerId) {
    try {
      await sshManager.withExecutor(targetServerId, async (exec) => {
        await exec.rm(REMOTE_BRANDING_DIR);
      });
    } catch (err) {
      console.warn(
        `[webmail] could not remove branding dir on ${targetServerId}: ${safeErrorMessage(err)}`,
      );
    }
  }

  // 3. Strip the webmail block from mail-state on the mail VPS.
  try {
    await sshManager.withExecutor(input.mailServerId, async (exec) => {
      await mutateState(exec, input.mailServerId, (state) => {
        if (!state.webmail) return state;
        const next: MailServerState = { ...state };
        delete next.webmail;
        return next;
      });
    });
  } catch (err) {
    console.warn(
      `[webmail] could not clear mail-state webmail block on ${input.mailServerId}: ${safeErrorMessage(err)}`,
    );
  }
}

// ─── Project ensure ──────────────────────────────────────────────────────────

/**
 * Fixed webmail project config. NOT user-editable — reconciled every deploy.
 *
 * Layout of the shipped dist (see apps/email/scripts/build-release.ts):
 *   <remoteDir>/
 *     package.json        ← release orchestration
 *     client/             ← pre-built SPA (no node_modules)
 *     server/             ← runtime deps only; bun runs TS directly
 *
 * installCommand runs only in `server/` (client is already bundled);
 * buildCommand is empty (nothing to build on the target — the pipeline skips
 * the build step, see build-pipeline.ts); startCommand points the server at
 * the bundled SPA so it serves /* as static files.
 */
function webmailProjectConfig(releaseDistPath: string, port: number) {
  return {
    framework: "webmail",
    packageManager: "bun",
    // --frozen-lockfile fails the install if the dist's bun.lock and
    // package.json drift - better to error loudly than to silently
    // resolve to a different version on the target (we hit that exact
    // bug when shipping without a lockfile: `^0.3.4` resolved to 0.4.2
    // on the target, breaking the peer-dep contract).
    installCommand: "cd server && bun install --production --frozen-lockfile",
    buildCommand: "",
    outputDirectory: "",
    startCommand: 'CLIENT_BUILD_DIR="$PWD/client" bun run server/src/main.ts',
    productionMode: "host" as const,
    port,
    hasServer: true,
    // hasBuild gates BOTH install and build in the build-config factory
    // (`installCommand: hasBuild ? cmd : ""`). Webmail has no build step
    // (`buildCommand: ""`) but it DOES need an install. buildCommand="" is
    // honored downstream and the build step is cleanly skipped.
    hasBuild: true,
    buildImage: "oven/bun:latest",
    localPath: releaseDistPath,
  };
}

/**
 * Find-or-create the webmail project row for a given slug + config. Shared by
 * the iRedMail-backed (`webmail-<mailServerId>`) and external-backend
 * (`webmail-ext-<host>`) deploys — both are the same dist-based Zero project;
 * they differ only in slug + which backend the env map points Zero at.
 *
 * `localPath` points at the freshly-resolved release dist for this deploy; the
 * standard pipeline streams it to the target, installs, and starts.
 */
async function ensureWebmailProjectRow(
  organizationId: string,
  slug: string,
  releaseDistPath: string,
  port: number,
): Promise<{ projectId: string; groupId: string; project: Project }> {
  const WEBMAIL_CONFIG = webmailProjectConfig(releaseDistPath, port);

  // Slug is globally unique, but the row must be org-scoped so a different org
  // deploying the same slug gets a fresh row instead of finding a cross-org
  // one. Look up by slug, then treat an out-of-org hit as "not found".
  let app = await repos.projectGroup.findFirstBySlug(slug);
  if (app && app.organizationId !== organizationId) {
    app = undefined;
  }
  if (!app) {
    app = await repos.projectGroup.create({
      organizationId,
      name: PROJECT_NAME,
      slug,
    });
  }

  let project = await repos.project.findFirstBySlug(slug);
  if (project && project.organizationId !== organizationId) {
    project = undefined;
  }
  if (!project) {
    project = await repos.project.create({
      organizationId,
      groupId: app.id,
      name: PROJECT_NAME,
      slug,
      environmentName: "Production",
      environmentSlug: "production",
      environmentType: "production",
      ...WEBMAIL_CONFIG,
      // Webmail is a managed "app" — surfaces under the Apps tab, not Projects.
      // The marker is additive; the slug + framework==="webmail" branches (the
      // lifecycle install hook, teardown, /emails reconcile) are untouched.
      isApp: true,
      appTemplateId: "mail-webmail",
    });
  } else {
    // Defensive: confirm the row really is in this org before we mutate it.
    // findFirstBySlug is unscoped so we double-check here.
    assertResourceInOrg(project, "Project", organizationId, project.id);
    // Reconcile every deploy: fixed commands aren't user-editable, so a
    // divergence means we shipped a change since this row was created.
    const diverged = (Object.keys(WEBMAIL_CONFIG) as Array<keyof typeof WEBMAIL_CONFIG>).some(
      (k) => (project as Record<string, unknown>)[k] !== WEBMAIL_CONFIG[k],
    );
    if (diverged) {
      await repos.project.update(project.id, WEBMAIL_CONFIG);
      project = { ...project, ...WEBMAIL_CONFIG };
    }
    // Backfill the Apps marker for webmail rows created before it existed.
    if (!project.isApp) {
      await repos.project.update(project.id, { isApp: true, appTemplateId: "mail-webmail" });
      project = { ...project, isApp: true, appTemplateId: "mail-webmail" };
    }
  }

  return { projectId: project.id, groupId: app.id, project };
}

/**
 * iRedMail-backed webmail project — keyed off the mail server ID so redeploys
 * reuse the same project row.
 */
export async function ensureWebmailProject(
  organizationId: string,
  mailServerId: string,
  releaseDistPath: string,
): Promise<{ projectId: string; groupId: string; project: Project }> {
  return ensureWebmailProjectRow(
    organizationId,
    `webmail-${mailServerId}`,
    releaseDistPath,
    DEFAULT_INTERNAL_PORT,
  );
}

/**
 * Stable, collision-free slug tail for an external webmail. The readable base
 * is truncated for display, but a hash of the FULL hostname is appended so two
 * distinct hostnames that share a truncated prefix never map to the same slug
 * (which would repoint one webmail's route onto the other). Deterministic →
 * redeploying the same hostname reuses its row.
 */
function externalWebmailSlug(hostname: string): string {
  const h = hostname.toLowerCase();
  const base = h
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha1").update(h).digest("hex").slice(0, 8);
  return `${EXTERNAL_SLUG_PREFIX}${base || "app"}-${hash}`;
}

/**
 * External-backend webmail project (BYO IMAP/SMTP). Keyed off the public
 * hostname so redeploying the same webmail reuses its row — no mail server
 * anchor, so the mail-state lifecycle hooks skip it (see
 * mailServerIdFromWebmailSlug).
 */
export async function ensureExternalWebmailProject(
  organizationId: string,
  hostname: string,
  releaseDistPath: string,
  port: number,
): Promise<{ projectId: string; groupId: string; project: Project }> {
  return ensureWebmailProjectRow(
    organizationId,
    externalWebmailSlug(hostname),
    releaseDistPath,
    port,
  );
}

// ─── Deploy lifecycle ────────────────────────────────────────────────────────

/**
 * Where to run the webmail. Discriminated union - `self` for a
 * user-managed openship server, `cloud` for Opshcloud.
 */
export type WebmailDeployTarget =
  | { kind: "self"; serverId: string }
  | { kind: "cloud" };

export interface StartWebmailDeployInput {
  mailServerId: string;
  hostname: string;
  internalPort?: number;
  target: WebmailDeployTarget;
}

export interface StartWebmailDeployResult {
  deploymentId: string;
  projectId: string;
}

/**
 * Drive a webmail deploy through the standard project pipeline.
 *
 * Flow:
 *   1. Locate the pre-built dist at `apps/email/dist/` (fail-fast if absent).
 *   2. Reconcile the project row to that dist + the fixed webmail config.
 *   3. Sync the project route (hostname → OpenResty + Let's Encrypt).
 *   4. Mint / reuse the branding token + session key in mail-state.
 *   5. Ensure persistent dirs on the target (/var/lib/openship-webmail).
 *   6. Build the env map (PORT, COOKIE_DOMAIN, IMAP/SMTP, secrets…).
 *   7. Snapshot from the project, resolve the deploy target via
 *      resolveSnapshotTarget (webmail intent as the override) and the
 *      explicit `buildStrategy = "server"` via resolveStrategy (the
 *      pipeline's "build the image at the target" mode — image build runs
 *      on the target host / cloud builder, not the API host).
 *   8. Preflight - port availability, hostname validity, required fields.
 *   9. `createQueuedDeployment` + `startBuild`.
 *
 * The pipeline's build step is a no-op for webmail: the project's
 * `buildCommand` is empty so `runBuildPipeline` skips it (see
 * build-pipeline.ts:211). Install runs in `server/` only (just runtime
 * deps), then start boots `bun run server/src/main.ts` which serves the
 * bundled `client/` next to it as static files.
 */
export async function startWebmailDeploy(
  ctx: RequestContext,
  input: StartWebmailDeployInput,
): Promise<StartWebmailDeployResult> {
  // ── 0. Org-scope guard (IDOR). The deploy route is tagged
  //       mail_server:write with NO :id param, so the framework only
  //       proved org membership — NOT that mailServerId (or the chosen
  //       target server) belongs to this org. Verify here, before any
  //       SSH / state read / build, so a member of org A can't deploy
  //       webmail onto org B's mail server by passing its id.
  const mailServer = await repos.server.get(input.mailServerId).catch(() => null);
  assertResourceInOrg(mailServer, "mail_server", ctx.organizationId, input.mailServerId);
  if (input.target.kind === "self") {
    const targetServer = await repos.server.get(input.target.serverId).catch(() => null);
    assertResourceInOrg(targetServer, "server", ctx.organizationId, input.target.serverId);
  }

  const internalPort = input.internalPort ?? DEFAULT_INTERNAL_PORT;
  const publicUrl = `https://${input.hostname}/`;
  const publicOrigin = `https://${input.hostname}`;

  // ── 1. Locate the pre-built webmail dist on the API host. NO build
  //       runs here - the dist must already exist (operator runs
  //       `bun run build` in apps/email/ ahead of time, OR we download
  //       the matching release tarball from GitHub into the cache).
  //       If all three slots fail, fail fast with a clear message. ────
  const releaseDistPath = await resolveWebmailDistDir();

  // ── 2. Project row carries localPath (the dist) + fixed config ──────
  const { project, projectId } = await ensureWebmailProject(
    ctx.organizationId,
    input.mailServerId,
    releaseDistPath,
  );

  // ── 3. Read mail-state for install domain + reuse existing branding /
  //       session-key secrets. Needed before route sync because the
  //       cloud + mail.<install> case skips custom-domain routing on
  //       the deploy target (the mail VPS proxies for it instead). ───
  const { block: existingState, installDomain: mailInstallDomain } =
    await readExistingWebmailBlock(input.mailServerId);
  if (!mailInstallDomain) {
    // Without the mail VPS's install domain we can't tell Zero where IMAP /
    // SMTP live, and every webmail sign-in would fall back to
    // `mail.<userDomain>` - broken for additional domains, and a TLS-cert
    // mismatch for any user whose domain isn't the install one. Fail fast
    // here rather than ship a webmail that can't authenticate anyone.
    throw new Error(
      "Mail server install state is missing - finish the mail install before deploying webmail.",
    );
  }

  // When the chosen hostname is the mail VPS's own `mail.<install>`
  // subdomain, the DNS A record already pins it to the mail server (for
  // IMAP / SMTP). The operator CAN'T change that record without breaking
  // mail. So if they pick Opshcloud as the target, the cloud workload
  // gets a default *.opsh.io URL and the mail server's OpenResty proxies
  // `mail.<install>` → that URL. No DNS work for the operator.
  //
  // For any OTHER hostname (e.g. `webmail.foo.com`), the operator owns
  // DNS and points it themselves - normal cloud / self-hosted custom
  // domain flow.
  const isOwnMailSubdomain = input.hostname === `mail.${mailInstallDomain}`;
  const useProxyVariant = input.target.kind === "cloud" && isOwnMailSubdomain;

  // ── 4. Project route - for the proxy variant we DON'T register the
  //       hostname against the project (the cloud workload uses opsh.io;
  //       the mail VPS handles the public hostname via its own routing).
  //       Every other case goes through the standard custom-domain path. ─
  const projectDomains = await listProjectRouteRows(project.id);
  const routeState = await syncProjectRouteState(project, {
    projectDomains,
    nextPublicEndpoints: useProxyVariant
      ? [] // no custom domain on the cloud workload - proxy lives on mail VPS
      : [
          {
            port: internalPort,
            customDomain: input.hostname,
            domainType: "custom",
          },
        ],
  });

  // ── 5. Mint / reuse secrets, persist mail-state. `installed` stays
  //       false until the deploy success hook flips it. ─────────────────
  const brandingToken =
    existingState?.brandingToken ?? randomBytes(32).toString("hex");
  const sessionEncryptionKey =
    existingState?.sessionEncryptionKey ?? randomBytes(32).toString("hex");
  const webmailState: MailWebmailState = {
    installed: false,
    target: input.target.kind === "cloud" ? "cloud" : "self",
    targetServerId: input.target.kind === "self" ? input.target.serverId : "",
    hostname: input.hostname,
    url: publicUrl,
    internalPort,
    brandingToken,
    sessionEncryptionKey,
    deployedAt: new Date().toISOString(),
    version: "local",
  };
  await persistWebmailBlock(input.mailServerId, webmailState);

  // ── 6. Persistent dirs on the target - only meaningful for self-hosted
  //       deploys. Cloud runs in an ephemeral container managed by
  //       Opshcloud; persistence there is handled by the cloud platform. ─
  if (input.target.kind === "self") {
    await prepareTarget(input.target.serverId);
  }

  // ── 7. Build the env map in memory. Webmail env vars are fixed by
  //       openship (not user-editable in the project Env Vars UI), so we
  //       bypass the project envVar table and pass them straight to the
  //       deployment - same direct path requestBuildAccess uses for
  //       caller-supplied vars. ACME_EMAIL is read by the SSL feature
  //       installer.
  //
  // IMAP / SMTP coordinates Zero uses to authenticate every sign-in.
  // Pinning to `mail.<installDomain>:993/465` here makes every user's
  // login route to the actual MTA, matching what `test-email.service.ts`
  // and `mail-credentials.service.ts` already use server-side.
  //
  // Public URLs are NOT injected here - the client reads its backend
  // URL from `window.location.origin` at runtime (see
  // client/lib/backend-url.ts). One dist, any hostname.
  //
  // SQLITE / BRANDING paths only point at the persistent host dir for
  // self-hosted deploys. Cloud writes to the container-local filesystem
  // (the cloud platform owns its own state layer); the defaults baked
  // into env.ts (`./data/...`) apply when these are omitted.
  const mailHost = `mail.${mailInstallDomain}`;
  const plainEnvMap: Record<string, string> = {
    PORT: String(internalPort),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    COOKIE_DOMAIN: input.hostname,
    TRUSTED_ORIGINS: publicOrigin,
    SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
    BRANDING_ADMIN_TOKEN: brandingToken,
    DEFAULT_IMAP_HOST: mailHost,
    DEFAULT_IMAP_PORT: "993",
    DEFAULT_SMTP_HOST: mailHost,
    DEFAULT_SMTP_PORT: "465",
    ACME_EMAIL: deriveAcmeEmail(input.hostname),
  };
  if (input.target.kind === "self") {
    plainEnvMap.SQLITE_PATH = REMOTE_SQLITE_PATH;
    plainEnvMap.BRANDING_PATH = REMOTE_BRANDING_DIR;
  }

  // ── 8. Snapshot → target → preflight → queue (shared tail). Cloud → cloud
  //       runtime; self → image built + run on the operator's server. ─────
  return finalizeWebmailDeploy(ctx, project, projectId, routeState, plainEnvMap, {
    deployTarget: input.target.kind === "cloud" ? "cloud" : "server",
    serverId: input.target.kind === "self" ? input.target.serverId : undefined,
  });
}

/**
 * Snapshot → resolve target → preflight → queue → start. The tail shared by
 * both webmail deploy paths (iRedMail-backed + external). The project row owns
 * build/install/start + port + localPath; this only pins the deploy-target
 * picker bits + the fixed "server" build strategy (image built AT the target —
 * target host via dockerode-over-SSH, or the cloud builder — never on the API
 * host). `plainEnvMap` is encrypted onto the deployment row; the pipeline
 * decrypts + feeds it to runtime.build + runtime.deploy.
 */
async function finalizeWebmailDeploy(
  ctx: RequestContext,
  project: Project,
  projectId: string,
  routeState: Awaited<ReturnType<typeof syncProjectRouteState>>,
  plainEnvMap: Record<string, string>,
  target: { deployTarget: DeployTarget; serverId?: string },
): Promise<StartWebmailDeployResult> {
  const snapshot = buildConfigSnapshot(project, "main");
  snapshot.serviceDeploymentMode = "single";

  const resolved = await resolveSnapshotTarget(project, {
    deployTarget: target.deployTarget,
    serverId: target.serverId,
    runtimeMode: "docker",
  });
  snapshot.deployTarget = resolved.deployTarget;
  snapshot.serverId = resolved.serverId;
  snapshot.runtimeMode = resolved.runtimeMode;
  snapshot.buildStrategy = await settingsService.resolveStrategy(snapshot.framework, "server", {
    deployTarget: resolved.deployTarget,
  });

  await runDeploymentPreflight(snapshot, routeState, { ctx });

  const dep = await createQueuedDeployment({
    projectId,
    organizationId: ctx.organizationId,
    branch: "main",
    environment: "production",
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptEnvVars(plainEnvMap),
    trigger: "manual",
  });
  await startBuild(dep.id);
  return { deploymentId: dep.id, projectId };
}

// ─── External-backend webmail (BYO IMAP/SMTP — SES / custom) ───────────────────

/** IMAP/SMTP backend Zero authenticates every sign-in against. */
export type WebmailBackendProvider = "ses" | "custom";

export interface WebmailExternalBackend {
  /** UI hint only — the host/port fields are used verbatim. */
  provider: WebmailBackendProvider;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export interface StartExternalWebmailDeployInput {
  hostname: string;
  backend: WebmailExternalBackend;
  target: { deployTarget: DeployTarget; serverId?: string };
  internalPort?: number;
}

/**
 * Read the session-encryption key + branding token from this webmail project's
 * PREVIOUS deployment env so a redeploy doesn't log everyone out / reset
 * branding. External webmail has no mail-state.json anchor (no mail server) —
 * the deployment env IS the persistence store. Fail-soft → caller mints fresh.
 */
async function readPriorWebmailSecrets(projectId: string): Promise<{
  sessionEncryptionKey: string | null;
  brandingToken: string | null;
}> {
  try {
    const last = await repos.deployment.findLatestByProject(projectId);
    const enc = (last?.envVars ?? null) as Record<string, string> | null;
    if (!enc) return { sessionEncryptionKey: null, brandingToken: null };
    const dec = decryptEnvMap(enc);
    return {
      sessionEncryptionKey: dec.SESSION_ENCRYPTION_KEY ?? null,
      brandingToken: dec.BRANDING_ADMIN_TOKEN ?? null,
    };
  } catch {
    return { sessionEncryptionKey: null, brandingToken: null };
  }
}

/**
 * Deploy the Zero webmail UI pointed at an EXTERNAL IMAP/SMTP backend — the
 * "Connect existing" provider path (SES for send + a read IMAP host, or fully
 * custom). Same dist-based pipeline as the iRedMail webmail, but:
 *
 *   - No mail server / mail-state.json. The project row + its deployment env
 *     are the only state; secrets are reused from the prior deployment.
 *   - Zero's DEFAULT_IMAP_HOST/PORT + DEFAULT_SMTP_HOST/PORT are pinned to the
 *     caller's backend instead of `mail.<installDomain>`.
 *   - No mail-VPS proxy variant (there's no iRedMail behind it).
 */
export async function startExternalWebmailDeploy(
  ctx: RequestContext,
  input: StartExternalWebmailDeployInput,
): Promise<StartWebmailDeployResult> {
  // Org-scope guard: a specific server target must belong to the caller's org.
  if (input.target.deployTarget === "server") {
    if (!input.target.serverId) {
      throw new Error("serverId is required when deploying to a server.");
    }
    const targetServer = await repos.server.get(input.target.serverId).catch(() => null);
    assertResourceInOrg(targetServer, "server", ctx.organizationId, input.target.serverId);
  }

  const internalPort = input.internalPort ?? DEFAULT_INTERNAL_PORT;
  const publicOrigin = `https://${input.hostname}`;

  const releaseDistPath = await resolveWebmailDistDir();
  const { project, projectId } = await ensureExternalWebmailProject(
    ctx.organizationId,
    input.hostname,
    releaseDistPath,
    internalPort,
  );

  // Always a standard custom-domain hostname (no mail-VPS proxy variant).
  const projectDomains = await listProjectRouteRows(project.id);
  const routeState = await syncProjectRouteState(project, {
    projectDomains,
    nextPublicEndpoints: [
      { port: internalPort, customDomain: input.hostname, domainType: "custom" },
    ],
  });

  const prior = await readPriorWebmailSecrets(projectId);
  const sessionEncryptionKey = prior.sessionEncryptionKey ?? randomBytes(32).toString("hex");
  const brandingToken = prior.brandingToken ?? randomBytes(32).toString("hex");

  // Persistent host dirs only for a self-hosted server target.
  if (input.target.deployTarget === "server" && input.target.serverId) {
    await prepareTarget(input.target.serverId);
  }

  const plainEnvMap: Record<string, string> = {
    PORT: String(internalPort),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    COOKIE_DOMAIN: input.hostname,
    TRUSTED_ORIGINS: publicOrigin,
    SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
    BRANDING_ADMIN_TOKEN: brandingToken,
    DEFAULT_IMAP_HOST: input.backend.imapHost,
    DEFAULT_IMAP_PORT: String(input.backend.imapPort),
    DEFAULT_SMTP_HOST: input.backend.smtpHost,
    DEFAULT_SMTP_PORT: String(input.backend.smtpPort),
    ACME_EMAIL: deriveAcmeEmail(input.hostname),
  };
  if (input.target.deployTarget === "server") {
    plainEnvMap.SQLITE_PATH = REMOTE_SQLITE_PATH;
    plainEnvMap.BRANDING_PATH = REMOTE_BRANDING_DIR;
  }

  return finalizeWebmailDeploy(ctx, project, projectId, routeState, plainEnvMap, input.target);
}


