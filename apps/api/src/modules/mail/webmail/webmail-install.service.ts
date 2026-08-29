/**
 * Webmail installs — the mail product's side of the GENERIC app installer.
 *
 * Webmail is an ordinary catalog app (`packages/core/src/apps/catalog/webmail.json`):
 * a published image, a declared volume, a declared HTTP endpoint. Nothing in this
 * file knows how to build, ship, route or run it — that is the same pipeline every
 * other app goes through, and the app installs from /apps just as well without us.
 *
 * What this file owns is the part the catalog can't know: WHICH IMAP/SMTP backend
 * a webmail belongs to. Two entry points, one shared core:
 *
 *   startWebmailDeploy          mail-server-backed — the backend is one of OUR
 *                               engines, so every coordinate is derived, not asked.
 *   startExternalWebmailDeploy  "Connect existing" — the operator's own backend.
 *
 * The core is three generic calls, in the same order the /apps/new/<id> wizard
 * makes them:
 *
 *   installApp()               → project + service rows + generated secrets
 *   updateAppProjectSettings() → the backend, as this app's own settings
 *   requestBuildAccess()       → queued deployment on the standard pipeline
 *
 * The only genuinely webmail-shaped things left are the mail-server LINK
 * (`mail_servers.webmail_project_id`) and the mail-VPS proxy for a cloud deploy on
 * `mail.<domain>` — a hostname whose DNS is pinned to the mail box for IMAP/SMTP,
 * so the operator cannot repoint it and we front it for them.
 */

import {
  AppError,
  getAppEndpoints,
  safeErrorMessage,
  type AppTemplate,
  type ComposeAdvanced,
  type OpenshipReadiness, mailHostname } from "@repo/core";
import { repos, type Domain, type Project } from "@repo/db";
import { assertResourceInOrg } from "../../../lib/controller-helpers";
import { pickCanonicalDomainRow, resolveServicePublicEndpoints } from "../../../lib/public-endpoints";
import type { RequestContext } from "../../../lib/request-context";
import { sshManager } from "../../../lib/ssh-manager";
import {
  ensureGeneratedAppSecrets,
  installApp,
  planInstallRouting,
  serviceRoutingPatch,
  type InstallAppRoute,
} from "../../apps/app-install.service";
import {
  updateAppProjectSettings,
  type AppSettingChange,
} from "../../apps/app-settings.service";
import { getTemplateForOrg } from "../../apps/catalog-source";
import { requestBuildAccess } from "../../deployments/build.service";
import { listProjectRouteRows } from "../../domains/project-route.service";
import { updateService } from "../../services/service.service";
import { mutateState, readState, type MailServerState } from "../mail-state";

// ─── The app this installs ───────────────────────────────────────────────────

/** Catalog id. The app is installable from /apps like any other. */
export const WEBMAIL_TEMPLATE_ID = "webmail";

/**
 * Template id stamped by the PRE-CATALOG webmail (a project whose source was a
 * prebuilt `apps/email/dist` shipped over SSH, with fixed install/start commands
 * and a host-bind state dir). Those rows can't be REDEPLOYED by this path — the
 * dist pipeline they need is gone — so deploying over one REPLACES it: tear the
 * old project down, then install the catalog app in its place. Destructive, so
 * it takes explicit consent (`replaceLegacy`).
 */
const LEGACY_WEBMAIL_TEMPLATE_ID = "mail-webmail";

/** Error code on the consent refusal, so a client can offer the replace itself. */
export const LEGACY_WEBMAIL_ERROR_CODE = "LEGACY_WEBMAIL";

/** Where a legacy webmail kept its session DB + branding, per project slug. */
const LEGACY_PERSIST_ROOT = "/var/lib/openship-webmail";

/**
 * The env keys the catalog app exposes as settings, in one place, because they
 * are a CONTRACT with `catalog/webmail.json`: a key renamed there and not here
 * surfaces as `Unknown setting: webmail.X` at install time. `webmail-catalog-contract.test.ts`
 * asserts the catalog still declares every one of them.
 */
export const WEBMAIL_SETTING_KEYS = {
  imapHost: "DEFAULT_IMAP_HOST",
  imapPort: "DEFAULT_IMAP_PORT",
  smtpHost: "DEFAULT_SMTP_HOST",
  smtpPort: "DEFAULT_SMTP_PORT",
  trustedOrigins: "TRUSTED_ORIGINS",
} as const;

/**
 * Our mail engine's client coordinates. The catalog's own placeholders stay
 * generic (993 / 587) because the app is generic — these pin the backend we
 * actually installed.
 *
 * 465 is implicit TLS, and that is what our Postfix submission service listens
 * on (`platform-mailbox.service.ts`, `MAIL_PORTS`); Zero selects the mode from
 * the port alone (`secure: port === 465`), so this is the whole configuration.
 */
const OUR_IMAP_PORT = "993";
const OUR_SMTP_PORT = "465";

// ─── Public shapes ───────────────────────────────────────────────────────────

export type WebmailDeployTarget =
  | { kind: "self"; serverId: string }
  | { kind: "cloud" };

export interface StartWebmailDeployInput {
  mailServerId: string;
  /** Public hostname for the webmail UI. */
  hostname: string;
  target: WebmailDeployTarget;
  /**
   * Consent to REPLACE a pre-catalog webmail: its project row, its container and
   * its host state dir go, then the catalog app installs in their place.
   *
   * Required rather than implied. Mailboxes and mail data live on the mail server
   * and are untouched, but the old webmail's sign-in sessions and per-user settings
   * are in the install being removed — that is the operator's call, not ours.
   */
  replaceLegacy?: boolean;
}

export interface StartExternalWebmailDeployInput {
  hostname: string;
  /** The operator's own backend — used verbatim, never rewritten. */
  backend: {
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
  };
  /**
   * Where to install — a BINDING, so a server row or a cloud workspace. There is
   * no "local": that value is what a project with neither derives (project.ts),
   * never something a client names, and on a server-host this box is already its
   * own "This Server" row. Taking it from a request body meant a caller could ask
   * for "this machine" and get a webmail whose only address was `localhost`.
   */
  target: { deployTarget: "server" | "cloud"; serverId?: string };
}

export interface WebmailDeployResult {
  deploymentId: string;
  projectId: string;
}

/**
 * What /emails needs to know about a mail server's webmail. Derived entirely
 * from the DB — the project row, its domain rows and its latest deployment —
 * so it can't drift from what the projects UI shows, and it costs no SSH.
 */
export interface WebmailSummary {
  /** The live deploy succeeded. Drives Open-webmail vs Deploy-webmail. */
  installed: boolean;
  /** Hostname the operator opens. "" when nothing is routed yet. */
  hostname: string;
  url: string;
  /**
   * The route list could not be read, so `hostname` is "" because we don't KNOW —
   * not because there is none. Callers that treat an empty hostname as "unrouted"
   * must check this first: the redeploy form prefills `mail.<domain>` on an absent
   * hostname, which on a webmail that already has one MOVES it.
   */
  routingUnknown: boolean;
  /** Webmail is an ordinary project; this is where it's managed. */
  projectId: string | null;
  /**
   * This webmail predates the catalog app and can only be REPLACED, not redeployed.
   * Surfaced so the UI can offer the upgrade on an install that still works — a
   * legacy webmail reports `installed: true`, so nothing else would ever prompt.
   */
  legacy: boolean;
}

// ─── Catalog lookups ─────────────────────────────────────────────────────────

async function requireWebmailTemplate(organizationId: string): Promise<AppTemplate> {
  const template = await getTemplateForOrg(organizationId, WEBMAIL_TEMPLATE_ID);
  if (!template) {
    throw new AppError(
      "The webmail app isn't in this instance's app catalog. Update Openship, then install webmail again.",
      409,
    );
  }
  return template;
}

/**
 * The one service + container port the webmail app serves on, read off the
 * template. Never a constant here: the image bakes its own PORT, and the
 * catalog is what declares it (`endpoints[0]`).
 */
function webmailEndpoint(template: AppTemplate): { service: string; port: number } {
  const endpoint = getAppEndpoints(template)[0];
  if (!endpoint) {
    throw new AppError("The webmail app declares no endpoint to route.", 409);
  }
  return { service: endpoint.service, port: endpoint.port };
}

// ─── The shared install core ─────────────────────────────────────────────────

interface WebmailInstallPlan {
  /** Deterministic, so a retry after a failed deploy ADOPTS the same draft. */
  name: string;
  /** Empty = deliberately unrouted (the mail VPS fronts the hostname). */
  routes: InstallAppRoute[];
  settings: AppSettingChange[];
  deployTarget: "server" | "cloud";
  serverId?: string;
  /**
   * An already-LINKED project to redeploy instead of installing fresh. Not
   * necessarily a deployed one: `beforeDeploy` stamps the mail server's FK before the
   * build is queued, so a retry after a failed first deploy arrives here too — which
   * is why the generated-secret backfill cannot live in the else branch.
   */
  reuse?: Project;
  /** Runs after the project exists and BEFORE the deploy is queued. */
  beforeDeploy?: (projectId: string) => Promise<void>;
  /**
   * Apply `routes` only AFTER `beforeDeploy` has run.
   *
   * For the mail server's own hostname the order is the authorization: the claim is
   * allowed on the strength of `mail_servers.webmail_project_id` pointing at this
   * project, and `beforeDeploy` is what stamps that link (#566). Routing first would be
   * refused as a foreign hostname — the mail row belongs to the mail install's
   * certificate renewal, not to any project.
   */
  routeAfterLink?: boolean;
}

async function runWebmailInstall(
  ctx: RequestContext,
  template: AppTemplate,
  plan: WebmailInstallPlan,
): Promise<WebmailDeployResult> {
  let projectId: string;

  if (plan.reuse) {
    projectId = plan.reuse.id;
    if (!plan.routeAfterLink) await reapplyRouting(ctx, template, plan.reuse, plan.routes);
  } else {
    // The generic installer owns everything about the app itself: project row,
    // service rows, declared volumes, and the FIRST write of the generated
    // SESSION_ENCRYPTION_KEY / BRANDING_ADMIN_TOKEN — first, not only: adoption skips
    // that write for rows it did not create, so the guarantee comes from
    // `ensureGeneratedAppSecrets` below. A same-named draft from a failed attempt is
    // adopted here rather than duplicated, which is why the name is derived, not typed.
    const installed = await installApp(ctx, {
      templateId: WEBMAIL_TEMPLATE_ID,
      name: plan.name,
      routes: plan.routeAfterLink ? [] : plan.routes,
    });
    if (installed.kind !== "template") {
      throw new AppError("The webmail app isn't installable on this instance.", 409);
    }
    projectId = installed.projectId;
  }

  // The backend goes in as this app's OWN settings — the same rows the app's
  // settings tab writes — so an operator can correct a host or port later
  // without a mail-specific endpoint, and a redeploy carries it forward.
  if (plan.settings.length > 0) {
    await updateAppProjectSettings(ctx, projectId, plan.settings);
  }

  // Both branches, one call. The image treats SESSION_ENCRYPTION_KEY as fatal, so a
  // project that reached the container without one crash-loops forever (issue #566) —
  // and the reuse branch, which every retry takes, installs nothing. Idempotent: a
  // stored key is reused, never rotated. Deliberately after the settings write, which
  // is what proves this project really is the webmail app before we write its env.
  await ensureGeneratedAppSecrets(projectId, template);

  // A crash loop must not report success. The restart-loop watch already exists
  // (#335) but is OFF by default and webmail never asked for it, so a container that
  // exited on a missing SESSION_ENCRYPTION_KEY and restarted ten times still finished
  // the deploy as "deployed and running" (#566).
  await enableRestartLoopWatch(ctx, projectId, template);

  // Before the deploy, never after: the deploy's success hook resolves the mail
  // server FROM the project, and a build can finish before a later write lands.
  await plan.beforeDeploy?.(projectId);

  // The mail host's route, now that the link authorizing it exists. Same plan builder
  // and same per-service write as a first install — the only difference is that it could
  // not have been accepted a few lines earlier.
  if (plan.routeAfterLink) {
    const project = await repos.project.findById(projectId);
    if (project) await reapplyRouting(ctx, template, project, plan.routes);
  }

  const dep = await requestBuildAccess(ctx, {
    projectId,
    serviceDeploymentMode: "services",
    deployTarget: plan.deployTarget,
    serverId: plan.deployTarget === "server" ? plan.serverId : undefined,
  });

  return { projectId, deploymentId: dep.deployment_id };
}

/**
 * Webmail's readiness gate: watch for a restart loop, and let it veto the deploy.
 *
 * No TCP probe. That asks a different question, and an enabled one adds up to 45s to
 * the critical path; what distinguishes "it started" from "it kept starting" is the
 * restart count. `onFailure: "fail"` because the deploy status vocabulary has no
 * "started but unhealthy" — for a container that is bouncing, `failed` is the only
 * honest verdict, and a warn would leave the deploy green.
 */
const WEBMAIL_READINESS: OpenshipReadiness = { stabilization: true, onFailure: "fail" };

/**
 * Opt the webmail service into the restart-loop watch, once.
 *
 * Best-effort by design: a readiness row we could not write must not abort a deploy
 * that would otherwise queue. Losing the watch costs honesty on a failure; throwing
 * here costs the deploy. An `advanced.readiness` that already exists is left alone —
 * that is an operator's explicit choice about their own project.
 *
 * Scoped to the endpoint service rather than every row: the gate is per-service, and a
 * future multi-service webmail should not have a sidecar's restarts veto the deploy.
 */
async function enableRestartLoopWatch(
  ctx: RequestContext,
  projectId: string,
  template: AppTemplate,
): Promise<void> {
  try {
    const name = webmailEndpoint(template).service;
    const row = (await repos.service.listByProject(projectId)).find((r) => r.name === name);
    if (!row) return;
    if ((row.advanced as ComposeAdvanced | null)?.readiness) return;
    await updateService(ctx, projectId, row.id, { advanced: { readiness: WEBMAIL_READINESS } });
  } catch (err) {
    console.warn(
      `[webmail] could not enable the restart-loop watch on ${projectId}: ${safeErrorMessage(err)}`,
    );
  }
}

/**
 * Re-apply the chosen routing to a project that already exists — the branch
 * `installApp` can't take, because its adoption only matches never-deployed
 * drafts. Same plan builder and same per-service write the installer uses, so a
 * corrected hostname (or the proxy variant's deliberate no-hostname) lands
 * exactly as it would on a first install.
 */
async function reapplyRouting(
  ctx: RequestContext,
  template: AppTemplate,
  project: Project,
  routes: InstallAppRoute[],
): Promise<void> {
  const plan = planInstallRouting(template, project.slug ?? project.name, routes);
  const rows = await repos.service.listByProject(project.id);
  for (const row of rows) {
    const routing = plan.get(row.name);
    if (!routing) continue;
    await updateService(ctx, project.id, row.id, serviceRoutingPatch(routing));
  }
}

// ─── Mail-server-backed install ──────────────────────────────────────────────

/**
 * Install (or redeploy) the webmail that serves one of OUR mail servers.
 *
 * Everything the app needs is derived from the mail server: IMAP and SMTP are
 * `mail.<installDomain>` on 993/465, and they stay ours even when an outbound
 * relay is configured. That is the point of split delivery
 * (`admin/outbound-relay.service.ts`): webmail submits to our Postfix, which
 * decides per envelope sender whether to relay onward. Pointing the client
 * straight at the provider would skip amavis (nothing would DKIM-sign with our
 * key), ignore the `selected`-scope sender rules, and require handing the
 * provider's SASL credential to a webmail — three regressions for no gain.
 */
export async function startWebmailDeploy(
  ctx: RequestContext,
  input: StartWebmailDeployInput,
): Promise<WebmailDeployResult> {
  // Org-scope guard (IDOR). The route is tagged mail_server:write with NO :id
  // param, so the framework proved org MEMBERSHIP only — not that this mail
  // server, or the chosen target, belongs to the caller's org.
  const mailServer = await repos.server.get(input.mailServerId).catch(() => null);
  assertResourceInOrg(mailServer, "mail_server", ctx.organizationId, input.mailServerId);
  if (input.target.kind === "self") {
    const targetServer = await repos.server.get(input.target.serverId).catch(() => null);
    assertResourceInOrg(targetServer, "server", ctx.organizationId, input.target.serverId);
  }

  const record = await repos.mailServer.get(input.mailServerId);
  const installDomain = record?.domain?.trim().toLowerCase();
  if (!installDomain) {
    // Without the install domain we can't tell the client where IMAP/SMTP live,
    // and every sign-in would fall back to `mail.<the user's own domain>` —
    // broken for additional domains, and a cert mismatch for anyone whose
    // domain isn't the install one. Fail before anything is written.
    throw new AppError(
      "Mail server install state is missing - finish the mail install before deploying webmail.",
      409,
    );
  }

  const mailHost = mailHostname(installDomain);
  const isOwnMailSubdomain = input.hostname === mailHost;

  // `mail.<install>`'s A record is pinned to the mail box — it carries IMAP,
  // SMTP and that host's cert — so the operator cannot repoint it at another
  // server. Deploying there and expecting this hostname to serve is a dead
  // route, which the old code registered silently. Refuse with the two ways out.
  if (
    isOwnMailSubdomain &&
    input.target.kind === "self" &&
    input.target.serverId !== input.mailServerId
  ) {
    throw new AppError(
      `${mailHost} has to resolve to the mail server itself — that DNS record carries IMAP, SMTP and this host's certificate, so it can't point at another server. Deploy the webmail on the mail server, or give it a hostname of its own such as webmail.${installDomain}.`,
      400,
    );
  }

  // Cloud + the mail server's own subdomain: the cloud workload takes no
  // hostname (it gets its default *.opsh.io URL) and the mail VPS proxies
  // `mail.<install>` → that URL once the deploy succeeds. No DNS work for the
  // operator, who couldn't do it anyway.
  const useProxyVariant = input.target.kind === "cloud" && isOwnMailSubdomain;

  const linked = await resolveLinkedWebmailProject(
    ctx.organizationId,
    input.mailServerId,
    record?.webmailProjectId ?? null,
  );
  // A pre-catalog row is replaced, never redeployed — see LEGACY_WEBMAIL_TEMPLATE_ID.
  const legacy = linked && isLegacyWebmailProject(linked) ? linked : null;
  if (legacy && !input.replaceLegacy) throw legacyReplaceConsentRequired(legacy);

  const template = await requireWebmailTemplate(ctx.organizationId);
  const endpoint = webmailEndpoint(template);

  // The teardown is the LAST thing before the install, after every cheap refusal
  // above has passed: nothing may delete a working webmail and only then discover
  // that this instance's catalog is too old to hold the app replacing it.
  if (legacy) await replaceLegacyWebmail(ctx, legacy);

  return runWebmailInstall(ctx, template, {
    // Named after the mail server, not the hostname: changing where webmail is
    // reached must redeploy THIS project, never stand up a second one.
    name: `Webmail ${installDomain}`,
    routes: useProxyVariant
      ? []
      : [
          {
            service: endpoint.service,
            port: endpoint.port,
            mode: "custom",
            customDomain: input.hostname,
          },
        ],
    settings: [
      { service: endpoint.service, key: WEBMAIL_SETTING_KEYS.imapHost, value: mailHost },
      { service: endpoint.service, key: WEBMAIL_SETTING_KEYS.imapPort, value: OUR_IMAP_PORT },
      { service: endpoint.service, key: WEBMAIL_SETTING_KEYS.smtpHost, value: mailHost },
      { service: endpoint.service, key: WEBMAIL_SETTING_KEYS.smtpPort, value: OUR_SMTP_PORT },
      {
        service: endpoint.service,
        key: WEBMAIL_SETTING_KEYS.trustedOrigins,
        // The proxy variant has no route of its own, so the catalog's
        // `{{publicUrl:webmail}}` resolves to nothing and sign-in would be
        // refused as a cross-origin POST: pin the origin the browser sees.
        // "" everywhere else CLEARS the override, handing the key back to the
        // catalog token — which is what makes a hostname change self-correcting.
        value: useProxyVariant ? `https://${input.hostname}` : "",
      },
    ],
    deployTarget: input.target.kind === "cloud" ? "cloud" : "server",
    serverId: input.target.kind === "self" ? input.target.serverId : undefined,
    // The legacy row is gone by now, so this is a fresh install, not a redeploy.
    reuse: legacy ? undefined : (linked ?? undefined),
    // `mail.<install>` is routable only by the mail server's LINKED webmail, and the
    // link is stamped in `beforeDeploy` — so this one route has to wait for it (#566).
    routeAfterLink: isOwnMailSubdomain && !useProxyVariant,
    beforeDeploy: (projectId) =>
      repos.mailServer.setWebmailProject(input.mailServerId, projectId),
  });
}

// ─── External-backend install ────────────────────────────────────────────────

/**
 * The "Connect existing" path: the same app, pointed at a backend we don't run.
 * No mail server, so no link, no proxy variant and no derived coordinates — the
 * operator's hosts and ports are used verbatim.
 */
export async function startExternalWebmailDeploy(
  ctx: RequestContext,
  input: StartExternalWebmailDeployInput,
): Promise<WebmailDeployResult> {
  if (input.target.deployTarget === "server") {
    if (!input.target.serverId) {
      throw new AppError("serverId is required when deploying to a server.", 400);
    }
    const targetServer = await repos.server.get(input.target.serverId).catch(() => null);
    assertResourceInOrg(targetServer, "server", ctx.organizationId, input.target.serverId);
  }

  const template = await requireWebmailTemplate(ctx.organizationId);
  const endpoint = webmailEndpoint(template);

  return runWebmailInstall(ctx, template, {
    name: `Webmail ${input.hostname}`,
    routes: [
      {
        service: endpoint.service,
        port: endpoint.port,
        mode: "custom",
        customDomain: input.hostname,
      },
    ],
    settings: [
      {
        service: endpoint.service,
        key: WEBMAIL_SETTING_KEYS.imapHost,
        value: input.backend.imapHost,
      },
      {
        service: endpoint.service,
        key: WEBMAIL_SETTING_KEYS.imapPort,
        value: String(input.backend.imapPort),
      },
      {
        service: endpoint.service,
        key: WEBMAIL_SETTING_KEYS.smtpHost,
        value: input.backend.smtpHost,
      },
      {
        service: endpoint.service,
        key: WEBMAIL_SETTING_KEYS.smtpPort,
        value: String(input.backend.smtpPort),
      },
    ],
    deployTarget: input.target.deployTarget,
    serverId: input.target.serverId,
  });
}

// ─── Link resolution ─────────────────────────────────────────────────────────

function isLegacyWebmailProject(
  project: Pick<Project, "appTemplateId" | "framework">,
): boolean {
  return (
    project.appTemplateId === LEGACY_WEBMAIL_TEMPLATE_ID || project.framework === "webmail"
  );
}

/**
 * The webmail project serving a mail server: the stored FK, else the retired
 * `webmail-<serverId>` slug for a row installed before the link existed (which
 * this then stamps, so the fallback runs at most once per server).
 *
 * A project outside the caller's org resolves to null rather than throwing —
 * "not linked" is the honest answer, and it can't be used to probe ids.
 */
export async function resolveLinkedWebmailProject(
  organizationId: string,
  mailServerId: string,
  storedProjectId: string | null,
): Promise<Project | null> {
  if (storedProjectId) {
    const linked = await repos.project.findById(storedProjectId).catch(() => null);
    if (linked && linked.organizationId === organizationId) return linked;
  }
  const legacy = await repos.project.findFirstBySlug(`webmail-${mailServerId}`).catch(() => null);
  if (!legacy || legacy.organizationId !== organizationId) return null;
  await repos.mailServer
    .setWebmailProject(mailServerId, legacy.id)
    .catch(() => {}); // best-effort stamp; the fallback still answers correctly
  return legacy;
}

// ─── Status summary ──────────────────────────────────────────────────────────

/**
 * The /emails view of a mail server's webmail, or undefined when there is none.
 *
 * `installed` means the LIVE deployment is ready, so an interrupted deploy can't
 * leave an Open-webmail CTA pointing at nothing — and `projectId` is returned
 * either way, because a failed build's logs are exactly where the operator needs
 * to go.
 */
export async function resolveWebmailSummary(
  organizationId: string,
  mailServer: { serverId: string; domain: string; webmailProjectId: string | null },
): Promise<WebmailSummary | undefined> {
  const project = await resolveLinkedWebmailProject(
    organizationId,
    mailServer.serverId,
    mailServer.webmailProjectId,
  );
  if (!project) return undefined;

  // `null`, not `[]`, on a failed read: the proxy variant is DERIVED from having no
  // route rows, so an unreadable list would otherwise be indistinguishable from an
  // unrouted project and this would hand back `mail.<domain>` for a self-hosted
  // webmail that has a hostname of its own — an Open-webmail CTA pointing at the
  // mail box instead of the webmail. Unknown routing yields no hostname at all.
  const rows: Domain[] | null = await listProjectRouteRows(project.id).catch(() => null);
  // The hostname the operator ROUTED, not the one we've verified: a custom
  // domain behind a CDN may never verify, yet its vhost is written and it is
  // still the address they open. `resolveProjectAccess` is deliberately
  // stricter — it feeds the projects UI, where "unverified" is the point.
  const routed = rows ? pickCanonicalDomainRow(rows) ?? rows[0] ?? null : null;
  // No route of its own + running on the cloud = the mail VPS fronts it (see
  // the proxy variant above). Derived, so nothing has to be stored.
  const proxied = rows !== null && !routed && !!project.cloudWorkspaceId;
  // A webmail on the mail server's OWN hostname has no domain row by design — that row
  // belongs to the mail install's certificate renewal and must stay project-less (#566,
  // see lib/mail-host-claim). Its address therefore has to come from the SERVICE's routing
  // instead, or a webmail that is deployed and serving reads as "not installed" and the
  // card offers to deploy it again.
  const hostname =
    routed?.hostname ??
    (proxied ? mailHostname(mailServer.domain) : rows === null ? "" : await routedServiceHostname(project));

  return {
    installed: await isLiveDeploymentReady(project.activeDeploymentId),
    hostname,
    url: hostname ? `https://${hostname}` : "",
    // Withholding the hostname is the safe half; saying so is the other half. Without
    // this the caller sees the same shape as a deployed-but-unrouted webmail, and the
    // two want opposite handling — one needs an address chosen, the other must not
    // have one chosen for it.
    routingUnknown: rows === null,
    projectId: project.id,
    legacy: isLegacyWebmailProject(project),
  };
}

/**
 * The hostname this project's services actually route, read from the service rows.
 *
 * Only consulted when the project has no domain row at all. Restricted to `custom`
 * endpoints: a free `*.opsh.io` route always has a row, so a rowless free endpoint would
 * mean a routing state we could not have written, and guessing one is how a stale address
 * ends up on the card.
 */
async function routedServiceHostname(project: Pick<Project, "id" | "slug" | "name">): Promise<string> {
  const rows = await repos.service.listByProject(project.id).catch(() => []);
  for (const row of rows) {
    const endpoints = resolveServicePublicEndpoints(row, {
      projectSlug: project.slug ?? project.name,
    });
    const custom = endpoints.find((e) => e.domainType === "custom" && e.customDomain);
    if (custom?.customDomain) return custom.customDomain;
  }
  return "";
}

async function isLiveDeploymentReady(deploymentId: string | null): Promise<boolean> {
  if (!deploymentId) return false;
  const dep = await repos.deployment.findById(deploymentId).catch(() => null);
  return dep?.status === "ready";
}

// ─── Deploy-success hook ─────────────────────────────────────────────────────

/**
 * Register the mail VPS proxy for a cloud webmail on `mail.<domain>`.
 *
 * Called for every successful deployment and returns immediately for anything
 * that isn't a webmail, so the lifecycle needs no webmail knowledge of its own.
 * Idempotent: a redeploy re-points the proxy at the new URL.
 */
export async function onWebmailDeployed(
  project: Pick<Project, "id" | "appTemplateId" | "organizationId" | "cloudWorkspaceId">,
  deployedUrl?: string | null,
): Promise<void> {
  if (project.appTemplateId !== WEBMAIL_TEMPLATE_ID) return;
  // Only a CLOUD workload can need the proxy; a self-hosted webmail routes its
  // own hostname through the standard pipeline.
  if (!project.cloudWorkspaceId || !deployedUrl) return;

  try {
    const mailServer = await repos.mailServer.findByWebmailProject(project.id);
    if (!mailServer?.domain) return;
    // A cloud webmail that DID take a hostname of its own is already served by
    // the edge; the proxy is for the routeless variant only. Uncaught on purpose:
    // this decides whether to WRITE a vhost, so a read we could not perform must
    // reach the catch below and be logged, never be read as "no routes".
    const rows = await listProjectRouteRows(project.id);
    if (rows.length > 0) return;

    const platform = await resolveMailVpsPlatform(mailServer.serverId, project.organizationId);
    await platform.routing.registerRoute({
      domain: mailHostname(mailServer.domain),
      tls: true,
      // We issue this host's cert right below, so the edge must keep a :443
      // listener up meanwhile — a routed host with no TLS listener refuses
      // the handshake (Cloudflare 525, #308), which also blocks issuance.
      terminatesTlsLocally: true,
      targetUrl: deployedUrl,
    });
    // The mail box already holds certs for IMAP/SMTP; this adds the HTTPS
    // one for the webmail UI, through the same Let's Encrypt feature.
    await platform.ssl.provisionCert(mailHostname(mailServer.domain));
  } catch (err) {
    console.warn(
      `[webmail] could not front mail.<domain> for project ${project.id}: ${safeErrorMessage(err)}`,
    );
  }
}

// ─── Teardown hook ───────────────────────────────────────────────────────────

/**
 * The webmail-specific teardown the generic project cleanup can't cover: a proxy
 * vhost on a DIFFERENT server (the mail VPS) than the one the project ran on.
 *
 * Removing that route deletes the vhost, its route.json and — at most — the
 * bootstrap PLACEHOLDER cert; a real certbot cert is deliberately left alone
 * (`packages/adapters/src/infra/nginx.ts`), so IMAPS/SMTPS on the same hostname
 * keep serving. Named volumes and the container go through the generic path.
 *
 * Returns a detail string for the teardown step, or null when there was nothing
 * webmail-shaped to do.
 */
export async function cleanupWebmailInstall(project: Project): Promise<string | null> {
  if (isLegacyWebmailProject(project)) return cleanupLegacyWebmail(project);
  if (project.appTemplateId !== WEBMAIL_TEMPLATE_ID) return null;

  const mailServer = await repos.mailServer.findByWebmailProject(project.id);
  if (!mailServer?.domain) return null;

  // Same derivation as the install, but `[]` on a failed read rather than the
  // summary's `null`: here the two mistakes are not symmetric. Attempting the
  // removal for a project that had its own hostname is a no-op (we never wrote
  // that vhost), while skipping it leaves a proxy vhost on the mail VPS with no
  // project left to ever remove it.
  const rows: Domain[] = await listProjectRouteRows(project.id).catch(() => []);
  if (rows.length > 0 || !project.cloudWorkspaceId) return null;

  const hostname = mailHostname(mailServer.domain);
  const platform = await resolveMailVpsPlatform(mailServer.serverId, project.organizationId);
  await platform.routing.removeRoute(hostname);
  return `removed ${hostname} proxy`;
}

/**
 * The mail VPS's own edge — the same OpenResty that fronts IMAP/SMTP for this
 * hostname — as a platform to route against. `resolveTargetPlatform` verifies the
 * server is in the org; the import is dynamic to keep the mail module out of the
 * deployment runtime's import cycle.
 */
async function resolveMailVpsPlatform(mailServerId: string, organizationId: string) {
  const { resolveTargetPlatform, disposePlatform } = await import("../../../lib/deployment-runtime");
  const platform = await resolveTargetPlatform("server", "bare", mailServerId, organizationId);
  // Released here rather than at each caller, because a caller that only wants `.routing`
  // is exactly the one that forgets: `createPlatform` builds its runtime EAGERLY, so an
  // SSH one has already bound a loopback bridge that only `dispose()` closes. A no-op
  // while this is `"bare"` — and disposal only releases `runtime`, never the pooled
  // `executor` that `.routing`/`.ssl` drive through, so both stay usable after it.
  disposePlatform(platform);
  return platform;
}

// ─── Legacy (pre-catalog) webmail ────────────────────────────────────────────

/**
 * The refusal a legacy webmail gets until the operator has said yes to replacing
 * it. Carries a code so the dashboard (and any other client) can offer the replace
 * instead of dead-ending on the message — which is what the pre-catalog rows used
 * to get: "go delete the project yourself, then come back".
 */
function legacyReplaceConsentRequired(project: Pick<Project, "name">): AppError {
  return new AppError(
    `"${project.name}" was deployed by an older Openship that shipped webmail as a prebuilt bundle instead of an image, so it can't be redeployed — it has to be replaced by the webmail app. Retry with replaceLegacy to do that now: the old webmail is removed and reinstalled from the image at the same hostname. Mailboxes and mail data live on the mail server and are untouched; the old webmail's sign-in sessions and per-user settings are not.`,
    409,
    LEGACY_WEBMAIL_ERROR_CODE,
  );
}

/**
 * Remove a pre-catalog webmail so the catalog app can take its place: the standard
 * project teardown, which drops the container, the routes and the row, and calls
 * back into `cleanupWebmailInstall` → `cleanupLegacyWebmail` for the host state dir
 * and the mail-state block the generic path can't know about.
 *
 * `force` so a stuck legacy build can't wedge the upgrade. NOT `forceOrphan`: if a
 * REACHABLE server refuses to give up the old container, we stop here rather than
 * install a second webmail for it to fight over the hostname and host port. (An
 * unreachable server still orphans-and-drops, as every delete does — the old
 * container is GC'd when the box returns.)
 *
 * The link column is `ON DELETE SET NULL`, so the FK clears itself here and the
 * install stamps the new project id in `beforeDeploy`.
 */
async function replaceLegacyWebmail(ctx: RequestContext, project: Project): Promise<void> {
  // Dynamic: project-teardown imports cleanupWebmailInstall from this module, so a
  // static import back would close the cycle.
  const { teardownProject } = await import("../../projects/project-teardown");
  const result = await teardownProject(ctx, project.id, { force: true, wipeVolumes: true });
  if (!result.rowDeleted) {
    const detail = result.unrecoverable[0]?.error ?? result.rejection ?? "unknown reason";
    throw new AppError(
      `Couldn't remove the old webmail "${project.name}" (${detail}), so it wasn't replaced. Nothing was installed — the existing webmail is still running.`,
      409,
    );
  }
}

/**
 * Delete what a PRE-CATALOG webmail left outside its project: the host state dir
 * holding its session DB (encrypted mailbox passwords) and per-user settings, and
 * the `webmail` block in the mail server's state file that held the key those
 * sessions were encrypted with.
 *
 * Neither exists for a catalog install — the app's state is a declared named
 * volume the generic teardown removes — so this runs only for rows carrying the
 * retired marker. Best-effort: the project rows are already gone by the time this
 * runs, so a failure must not strand the operator.
 */
async function cleanupLegacyWebmail(project: Project): Promise<string> {
  const slug = project.slug;
  const mailServerId = legacyMailServerIdFromSlug(slug);

  // The state dir lived on whichever server the webmail RAN on, which is not
  // necessarily the mail VPS.
  const stateDirHost =
    project.serverId ??
    (mailServerId
      ? await sshManager
          .withExecutor(mailServerId, async (exec) => {
            const state = await readState(exec);
            return state?.webmail?.targetServerId ?? null;
          })
          .catch(() => null)
      : null);

  if (stateDirHost) {
    // Two layouts ever existed under this root: per-project (`<root>/<slug>`),
    // and — in the releases before that — the two entries below, flat at the
    // root, which is why only one webmail per host worked. The root ITSELF is
    // never removed: under the per-project layout a sibling webmail lives there.
    const paths = [
      `${LEGACY_PERSIST_ROOT}/${slug}`,
      `${LEGACY_PERSIST_ROOT}/zero.db`,
      `${LEGACY_PERSIST_ROOT}/branding`,
    ];
    await sshManager
      .withExecutor(stateDirHost, async (exec) => {
        for (const path of paths) await exec.rm(path);
      })
      .catch((err) =>
        console.warn(
          `[webmail] could not remove ${LEGACY_PERSIST_ROOT} state for ${slug}: ${safeErrorMessage(err)}`,
        ),
      );
  }

  if (mailServerId) {
    await sshManager
      .withExecutor(mailServerId, (exec) =>
        mutateState(exec, mailServerId, (state) => {
          if (!state.webmail) return state;
          const next: MailServerState = { ...state };
          delete next.webmail;
          return next;
        }),
      )
      .catch((err) =>
        console.warn(
          `[webmail] could not clear the legacy mail-state block on ${mailServerId}: ${safeErrorMessage(err)}`,
        ),
      );
  }

  return "legacy webmail";
}

/**
 * The mailServerId a legacy webmail encoded in its slug. `webmail-ext-*` was the
 * external-backend variant, which had no mail server at all.
 */
function legacyMailServerIdFromSlug(slug: string): string | null {
  if (slug.startsWith("webmail-ext-")) return null;
  return slug.match(/^webmail-(.+)$/)?.[1] ?? null;
}
