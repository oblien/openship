/**
 * Headless instance provisioning — the non-interactive counterpart to the
 * `@clack` install wizard (commands/wizard.ts). Turns install flags into the
 * exact loopback API calls the wizard makes (bootstrap-admin + self-register),
 * so `openship up --non-interactive …` provisions a box end-to-end without a TTY.
 *
 * The loopback API is internal-token-gated; the caller passes the token
 * (from `ensureInternalToken()`) so this module has no dependency on the `up`
 * command (avoids an import cycle). Secrets (admin password) come from flags/env,
 * never logged.
 *
 * The loopback API calls + internal token live in ./loopback-api — the SAME
 * copy the wizard uses (no duplication).
 */

import { isValidEmail } from "@repo/core";
import { internalPost, waitHealthy, bootstrapAdmin, ensureInternalToken } from "./loopback-api";

export type DomainKind = "byo" | "custom" | "free" | "none";

export interface InstallInputs {
  admin: { name: string; email: string; password: string };
  domain:
    | { kind: "byo"; hostname?: string }
    | { kind: "custom"; hostname: string; acmeEmail?: string; edge: "migrate" | "takeover" | "cancel" }
    | {
        kind: "free";
        slug: string;
        publicHost?: string;
        /** Bare install: stand up the local :80 edge Cloud forwards to, and (when
         *  a foreign proxy holds 80/443) take it over / migrate it. Ignored in
         *  compose — the container edge owns :80. */
        localEdge?: boolean;
        edgeTakeover?: boolean;
        edgeMigrate?: boolean;
        /** Corrected static roots (by primary hostname) the wizard copied into the
         *  edge's static bind mount host-side, for adopted static sites the container
         *  edge couldn't reach. Forwarded to self-register. See #456. */
        staticRootOverrides?: Record<string, string>;
      }
    | { kind: "none" };
}

/** Thrown when required headless inputs are missing/invalid in --non-interactive
 *  mode — surfaced with an actionable message, exit non-zero. */
export class HeadlessInputError extends Error {
  readonly code = "HEADLESS_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "HeadlessInputError";
  }
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;


/** Bare hostname from a URL or `host[:port]`. */
function hostOf(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    if (raw.includes("://")) return new URL(raw).hostname || undefined;
  } catch {
    /* fall through */
  }
  return raw.replace(/^\/+/, "").split("/")[0]?.split(":")[0] || undefined;
}

export interface InstallFlags {
  adminName?: string;
  adminEmail?: string;
  adminPassword?: string;
  domainKind?: string;
  hostname?: string;
  slug?: string;
  publicUrl?: string;
  acmeEmail?: string;
  edge?: string;
}

/**
 * Resolve headless install inputs from flags/env. Throws HeadlessInputError with
 * a precise message on anything missing/invalid — never silently defaults a
 * credential. Admin password falls back to OPENSHIP_ADMIN_PASSWORD so it stays
 * out of argv/shell history.
 */
export function resolveInstallInputs(flags: InstallFlags): InstallInputs {
  const email = flags.adminEmail?.trim();
  const password = flags.adminPassword ?? process.env.OPENSHIP_ADMIN_PASSWORD;
  const name = flags.adminName?.trim() || (email ? email.split("@")[0]! : "");

  if (!email || !isValidEmail(email)) {
    throw new HeadlessInputError("Missing/invalid --admin-email for a non-interactive install.");
  }
  if (!password || password.length < 8) {
    throw new HeadlessInputError(
      "Missing --admin-password (or OPENSHIP_ADMIN_PASSWORD env), min 8 chars, for a non-interactive install.",
    );
  }
  const admin = { name: name || "Admin", email, password };

  const kindRaw = (flags.domainKind?.trim().toLowerCase() || (flags.publicUrl ? "byo" : "none")) as DomainKind;
  const hostname = flags.hostname?.trim() || hostOf(flags.publicUrl);

  switch (kindRaw) {
    case "none":
      return { admin, domain: { kind: "none" } };
    case "byo":
      return { admin, domain: { kind: "byo", hostname } };
    case "custom": {
      if (!hostname) throw new HeadlessInputError("--domain-kind custom requires --hostname (or --public-url).");
      const edge = (flags.edge?.trim().toLowerCase() || "cancel") as "migrate" | "takeover" | "cancel";
      if (!["migrate", "takeover", "cancel"].includes(edge)) {
        throw new HeadlessInputError(`Invalid --edge "${flags.edge}" (expected migrate | takeover | cancel).`);
      }
      const acmeEmail = flags.acmeEmail?.trim() || email;
      if (!isValidEmail(acmeEmail)) {
        throw new HeadlessInputError(`Invalid --acme-email "${acmeEmail}" — Let's Encrypt rejects a malformed contact.`);
      }
      return { admin, domain: { kind: "custom", hostname, acmeEmail, edge } };
    }
    case "free": {
      const slug = (flags.slug?.trim() || (hostname ? hostname.split(".")[0] : "")).toLowerCase();
      if (!slug || !SLUG_RE.test(slug)) {
        throw new HeadlessInputError("--domain-kind free requires a valid --slug (lowercase letters, digits, hyphens).");
      }
      return { admin, domain: { kind: "free", slug, publicHost: hostOf(flags.publicUrl) } };
    }
    default:
      throw new HeadlessInputError(`Invalid --domain-kind "${flags.domainKind}" (expected byo | custom | free | none).`);
  }
}

// Loopback helpers (internalPost / waitHealthy / bootstrapAdmin) come from
// ./loopback-api — one shared copy with the wizard. The headless flow builds on them.

/** Create the first admin; if one already exists, force it back to LOCAL auth
 *  with the given password (idempotent re-provision). */
async function bootstrapOrReset(
  port: string,
  admin: InstallInputs["admin"],
  token?: string,
): Promise<{ ok: boolean; message?: string }> {
  const boot = await bootstrapAdmin(port, admin, token);
  if (boot.ok && boot.message !== "already-exists") return { ok: true };
  if (boot.ok && boot.message === "already-exists") {
    const rr = await internalPost(
      port,
      "/api/system/reset-admin-password",
      { password: admin.password, email: admin.email, name: admin.name },
      token,
    );
    return rr.ok ? { ok: true, message: "reset-existing" } : { ok: false, message: rr.data?.error || "reset failed" };
  }
  return { ok: false, message: boot.message || "bootstrap failed" };
}

/** Drain a self-register provisioning SSE stream best-effort (custom domain ACME).
 *  Never throws — the site serves over HTTP until the cert is ready. */
/**
 * Follow the provisioning SSE stream: print each step as it happens and return as
 * soon as the session reports a terminal event.
 *
 * This used to read frames and DISCARD them, ending only when the server closed
 * the socket (or after a 3-minute timeout). Two bad consequences: the operator saw
 * a frozen "Issuing HTTPS certificate…" line with no idea what was happening, and
 * a run whose work had already SUCCEEDED sat there for minutes because the edge
 * provisioning keeps its session open across retry backoffs. Parsing the events
 * fixes both — live progress, and we stop on `complete`/`end` instead of waiting
 * for a socket close that may be a minute away.
 *
 * Certs are best-effort by design, so the deadline is a bound, not a contract: if
 * it expires we say the work continues in the background rather than implying
 * failure.
 */
async function drainProvisionStream(
  port: string,
  sessionId: string,
  token?: string,
  onLog?: (message: string) => void,
): Promise<{ completed: boolean; detail?: string }> {
  let detail: string | undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/self-register/stream?id=${sessionId}`, {
      headers: { "X-Internal-Token": token ?? ensureInternalToken() },
      signal: AbortSignal.timeout(180000),
    });
    if (!res.body) return { completed: false };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = /event:\s*(.*)/.exec(frame)?.[1]?.trim();
        const dataRaw = /data:\s*([\s\S]*)/.exec(frame)?.[1]?.trim();
        if (!event || !dataRaw) continue;
        try {
          const d = JSON.parse(dataRaw) as { message?: string; level?: string; status?: string };
          if (event === "log" && d.message) {
            const msg = String(d.message).replace(/\s+/g, " ");
            onLog?.(msg);
            // Keep the last problem so a best-effort step that didn't work says why.
            if (d.level === "warn" || d.level === "error") detail = msg;
          } else if (event === "complete") {
            return { completed: d.status === "completed", detail };
          } else if (event === "end") {
            return { completed: true, detail };
          }
        } catch {
          /* a malformed frame is not worth failing the install over */
        }
      }
    }
  } catch {
    /* best-effort: the edge/cert work continues server-side and retries on boot */
  }
  return { completed: false, detail };
}

/** The SaaS reports a shared-zone slug conflict as 409 + code `slug_taken`. */
function isSlugTaken(data: unknown): boolean {
  const body = data as { code?: string; error?: string } | undefined;
  if (body?.code === "slug_taken") return true;
  return /already taken|slug_taken/i.test(body?.error ?? "");
}

export interface ProvisionResult {
  adminReady: boolean;
  domainRegistered: boolean;
  liveUrl?: string;
  warnings: string[];
}

/**
 * Headlessly provision an already-installed local instance: wait for health,
 * create the admin (or reset), then register the domain per `inputs`. Returns a
 * result + warnings; only a failed admin bootstrap is fatal (throws).
 */
export async function headlessProvision(opts: {
  port: string;
  dashPort?: string;
  inputs: InstallInputs;
  /** Internal token for the loopback calls. Bare install → omit (falls back to
   *  the ~/.openship token file); Compose install → the stack's compose/.env
   *  token (composeInternalToken). */
  token?: string;
  /** Install method. Informational: the provisioning calls are now identical for
   *  both — the api picks the host OpenResty or the container edge from
   *  OPENSHIP_EDGE_MODE, so the CLI doesn't branch on it. */
  method?: "bare" | "compose";
  onLog?: (msg: string) => void;
  /** Interactive recovery for a taken free subdomain: return a new slug, or null
   *  to give up. Omitted on headless runs, which just report the conflict. */
  onSlugTaken?: (taken: string) => Promise<string | null>;
}): Promise<ProvisionResult> {
  const { port, inputs, token } = opts;
  const log = opts.onLog ?? (() => {});
  const warnings: string[] = [];

  log("Waiting for the API to become healthy…");
  if (!(await waitHealthy(port))) {
    throw new HeadlessInputError("The API did not become healthy in time — check `openship logs`.");
  }

  log("Creating the admin account…");
  const admin = await bootstrapOrReset(port, inputs.admin, token);
  if (!admin.ok) throw new HeadlessInputError(`Could not create the admin account: ${admin.message}`);

  const dashPort = opts.dashPort ? Number(opts.dashPort) : undefined;
  const d = inputs.domain;
  let liveUrl: string | undefined;
  let domainRegistered = false;

  log(`Registering domain (${d.kind})…`);
  if (d.kind === "none") {
    await internalPost(port, "/api/system/self-register", { domainType: "byo" }, token);
    domainRegistered = true;
  } else if (d.kind === "byo") {
    const res = await internalPost(
      port,
      "/api/system/self-register",
      { domainType: "byo", ...(d.hostname ? { hostname: d.hostname } : {}) },
      token,
    );
    domainRegistered = res.ok;
    liveUrl = res.data?.url ?? (d.hostname ? `https://${d.hostname}` : undefined);
    if (!res.ok) warnings.push(`Domain registration returned: ${res.data?.error || "failed"}`);
  } else if (d.kind === "custom") {
    // Same call on compose and bare. It used to be skipped on compose out of a
    // fear that self-register would install + take over the HOST's OpenResty and
    // fight the container edge — it doesn't: with OPENSHIP_EDGE_MODE=docker,
    // `ensureSelfEdgeInfra` returns early and installs nothing, then
    // provisionSelfAppEdge routes + issues the cert THROUGH the edge container
    // (vhost to the shared sites volume, `openresty -s reload` + certbot via
    // `docker exec`). edgeTakeover/edgeMigrate are ignored in that mode — the
    // host-side takeover already happened in the pre-up preflight.
    const res = await internalPost(
      port,
      "/api/system/self-register",
      {
        domainType: "custom",
        hostname: d.hostname,
        dashPort,
        acmeEmail: d.acmeEmail,
        edgeTakeover: d.edge === "takeover",
        edgeMigrate: d.edge === "migrate",
      },
      token,
    );
    domainRegistered = res.ok;
    liveUrl = res.data?.url ?? `https://${d.hostname}`;
    if (res.ok && res.data?.sessionId) {
      log("Issuing HTTPS certificate (Let's Encrypt) — best-effort…");
      // Stream each step through `log` so this step SHOWS its work. Certbot can
      // take a while (DNS propagation, ACME retry backoffs) and a single static
      // line for a minute-plus reads as a hang — which is exactly how a run that
      // actually succeeded looked.
      const cert = await drainProvisionStream(port, String(res.data.sessionId), token, (m) =>
        log(`  ${m}`),
      );
      if (!cert.completed) {
        warnings.push(
          cert.detail
            ? `HTTPS certificate not issued yet: ${cert.detail}`
            : "HTTPS certificate not issued yet — it retries in the background and on the next boot.",
        );
      }
    } else if (!res.ok) {
      warnings.push(`Custom domain provisioning returned: ${res.data?.error || "failed"}`);
    }
  } else {
    // free — needs the box Cloud-connected (done just before this on the wizard
    // path). The slug lives in a SHARED zone, so it can be taken by someone else;
    // availability can't be checked at prompt time because Cloud isn't connected
    // yet then. So we check HERE, where a retry is still possible: `onSlugTaken`
    // lets an interactive caller pick another name instead of the run ending with
    // a domain that was never created.
    // One payload builder so every attempt forwards the same bare-install edge
    // flags (localEdge + the takeover choice) — the free branch used to drop them.
    const freeBody = (s: string) => ({
      domainType: "free" as const,
      slug: s,
      publicHost: d.publicHost,
      dashPort,
      localEdge: d.localEdge,
      edgeTakeover: d.edgeTakeover,
      edgeMigrate: d.edgeMigrate,
      ...(d.staticRootOverrides ? { staticRootOverrides: d.staticRootOverrides } : {}),
    });
    let slug = d.slug;
    let res = await internalPost(port, "/api/system/self-register", freeBody(slug), token);
    for (let attempt = 0; !res.ok && isSlugTaken(res.data) && opts.onSlugTaken && attempt < 5; attempt++) {
      const next = await opts.onSlugTaken(slug);
      if (!next) break; // caller declined to choose another
      slug = next;
      res = await internalPost(port, "/api/system/self-register", freeBody(slug), token);
    }
    domainRegistered = res.ok;
    liveUrl = res.data?.url;
    // Bare + localEdge stands the host edge up in the background (install +
    // takeover) and streams progress — the SAME session the custom branch drains.
    if (res.ok && res.data?.sessionId) {
      const edge = await drainProvisionStream(port, String(res.data.sessionId), token, (m) => log(`  ${m}`));
      if (!edge.completed && edge.detail) {
        warnings.push(`Local edge not fully ready: ${edge.detail} — it retries on next boot.`);
      }
    }
    if (!res.ok) {
      // Say what actually went wrong. This used to append "needs the box connected
      // to Openship Cloud first" to EVERY failure, which flatly contradicts the
      // "Connected to Openship Cloud as …" line printed seconds earlier when the
      // real cause was a taken slug.
      warnings.push(
        isSlugTaken(res.data)
          ? `Free domain not created: "${slug}.opsh.io" is already taken. Re-run and choose a different subdomain, or add one later in Settings → Domains.`
          : `Free .opsh.io domain not registered: ${res.data?.error || "failed"}. ` +
              `A free domain needs the box connected to Openship Cloud — connect it in Settings → Cloud, or use --domain-kind byo/custom.`,
      );
    }
  }

  return { adminReady: true, domainRegistered, liveUrl, warnings };
}
