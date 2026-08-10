/**
 * Interactive setup — what runs when you type `openship` with no subcommand.
 *
 * The one-command self-deploy: ask a few questions, then reuse the exact
 * `openship up` pipeline (prebuilt API + dashboard, no build) to install
 * Openship as a boot service, create the first admin, and — reusing Openship's
 * OWN app + domain pipeline — register the control plane as an **app** (it shows
 * up under Apps) with a domain:
 *   - Free   name.opsh.io  → Openship Cloud edge (Oblien); connects Cloud in-flow
 *   - Custom your-domain   → OpenResty + a free Let's Encrypt cert on this box
 *   - BYO    your-domain   → you run your own reverse proxy in front
 *
 * No new deploy machinery — Openship deploys itself with its own tools.
 * UI is @clack/prompts (modern, keyboard-driven).
 */

import chalk from "chalk";
import open from "open";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  intro,
  outro,
  text,
  password,
  select,
  spinner,
  note,
  log,
  cancel,
  isCancel,
} from "@clack/prompts";

import { isValidEmail } from "@repo/core";
import { startService, normalizeUrl } from "./up";
import {
  ensureInternalToken,
  internalGet,
  internalPost,
  bootstrapAdmin,
  waitHealthy,
  waitDashboard,
  detectPublicIp,
  OS_DIR,
} from "../lib/loopback-api";
import { ensureDashboard } from "../lib/dashboard";
import { serviceStatus, stop as stopService, restart as restartService } from "../lib/service";
import {
  saveInstanceUrl,
  readInstanceUrl,
  portMoveNotice,
  readStoredPorts,
  storedApiPort,
  storedDashboardPort,
} from "../lib/ports";
import { runRepair, looksCorrupted, lastServiceError } from "../lib/repair";
import {
  ensureDocker,
  dockerGap,
  hasDockerCompose,
  composeUp,
  composeInternalToken,
  composePrefetch,
  composeTrustedOriginUrls,
  resolveComposePorts,
  sourceBuildDir,
  readInstallMethod,
  composeDown,
  composeStart,
  composeRestart,
  composeRunning,
} from "../lib/compose";
import {
  planAndApplyHostEdge,
  rollbackHostEdge,
  completeHostEdge,
  renderEdgeConflict,
  confirmEdgeAction,
  remediateUnreachableStaticRoots,
} from "../lib/edge-preflight";
import { importMigratedSites } from "../lib/edge-import";
import { LocalExecutor, type ImportedSite, type UnreachableStaticRoot } from "@repo/adapters/proxy";
import { headlessProvision, type InstallInputs } from "../lib/instance-provision";

declare const __CLI_VERSION__: string;

/** Exit cleanly on Ctrl-C / Esc; otherwise narrow away clack's cancel symbol. */
function ensure<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/* Loopback API helpers (internalGet/internalPost/bootstrapAdmin/waitHealthy/
 * waitDashboard/detectPublicIp) now live in lib/loopback-api and are imported
 * above — one copy shared with the headless installer + `openship up`. */

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Connect the org owner to Openship Cloud via the browser PKCE handshake, then
 * finalize on the loopback API (internal-token gated). Returns the linked cloud
 * account (its email) on success, or null when not linked.
 */
async function connectOpenshipCloud(port: string, token?: string): Promise<{ email: string | null } | null> {
  const already = await internalGet(port, "/api/system/cloud-status");
  if (already?.connected) {
    log.success(`Already connected to Openship Cloud${already.user?.email ? ` as ${already.user.email}` : ""}.`);
    return { email: already.user?.email ?? null };
  }

  const capsEnv = await internalGet(port, "/api/health/env");
  const cloudApiUrl: string | undefined = capsEnv?.cloudApiUrl;
  if (!cloudApiUrl) {
    log.error("Couldn't discover the Openship Cloud URL — free domain unavailable. Use a custom domain instead.");
    return null;
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24)); // 192-bit unguessable poll capability

  const apiBase = cloudApiUrl.replace(/\/$/, "");
  // Device/poll handshake — the server-friendly flow (and fine locally too):
  // NO loopback listener and NO browser→box redirect. The CLI opens the auth
  // URL, the user clicks Authorize, and the CLI POLLS the SaaS with its
  // unguessable `state` to pick up the one-time, PKCE-locked code. This is why
  // it works over SSH — the browser (on the user's laptop) never has to reach
  // back to this box.
  //   - mode=device → the consent page confirms in-place; the code is delivered
  //     by the poll below, so there is NO redirect param at all.
  const handoff =
    `${apiBase}/api/cloud/connect-handoff` +
    `?state=${encodeURIComponent(state)}&code_challenge=${challenge}&mode=device`;

  const overSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT);
  // Print the URL as a bare, single-line, selectable value. clack's note() boxes
  // and gutters it, which wraps the URL across lines and makes it uncopyable.
  log.step("Open this URL in your browser to authorize, then click Authorize:");
  console.log("\n" + chalk.cyan.underline(handoff) + "\n");
  // A box with a desktop browser can auto-open it; over SSH there's none, so
  // the user opens the printed URL on their own machine.
  if (!overSsh) void open(handoff).catch(() => {});

  const s = spinner();
  s.start("Waiting for you to authorize in the browser");
  // Poll the SaaS for our code once the user approves. Fixed 2.5s cadence keeps
  // us well under the SaaS per-IP limit (300/min) across the 5-min window. The
  // box already needs SaaS reachability to finish the exchange below, so
  // polling here adds no new network requirement.
  let code: string | null = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch(
        `${apiBase}/api/cloud/connect-poll?state=${encodeURIComponent(state)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { status?: string; code?: string };
      if (data.status === "ready" && data.code) {
        code = data.code;
        break;
      }
    } catch {
      /* transient network blip — keep polling until the deadline */
    }
  }

  if (!code) {
    s.stop("Openship Cloud wasn't authorized in time — re-run the connect step to try again.", 1);
    return null;
  }
  s.stop("Authorized.");

  const linking = spinner();
  linking.start("Linking this instance to Openship Cloud");
  const res = await internalPost(port, "/api/system/cloud-connect", { code, codeVerifier: verifier }, token);
  if (!res.ok) {
    linking.stop(`Couldn't link Openship Cloud: ${res.data?.error || "failed"}`, 1);
    return null;
  }
  linking.stop(`Connected to Openship Cloud${res.data?.email ? ` as ${res.data.email}` : ""}.`);
  return { email: res.data?.email ?? null };
}

/** Prompt for a local admin (name / email / password). Used for the self-hosted
 *  paths and as the cloud-path fallback when the browser connect is declined. */
async function promptLocalAdmin(): Promise<{ name: string; email: string; password: string }> {
  const name = ensure(await text({ message: "Your name", validate: (v) => (v?.trim() ? undefined : "Required") })).trim();
  const email = ensure(
    await text({
      message: "Email",
      placeholder: "you@example.com",
      // Same rule the headless path enforces (isValidEmail) — an `@`-only check
      // let `test@gmail.co,` through and created an admin nobody could reach.
      validate: (v) => (isValidEmail(v ?? "") ? undefined : "Enter a valid email address"),
    }),
  )
    .trim()
    .toLowerCase();
  const pw = ensure(
    await password({ message: "Password", validate: (v) => (v && v.length >= 8 ? undefined : "At least 8 characters") }),
  );
  ensure(await password({ message: "Confirm password", validate: (v) => (v === pw ? undefined : "Passwords don't match") }));
  return { name, email, password: pw };
}

/** Consume the self-register SSE stream, driving the spinner until done. */
async function streamProvision(
  port: string,
  sessionId: string,
  s: ReturnType<typeof spinner>,
): Promise<{ ok: boolean; detail?: string }> {
  let ok = false;
  // Remember the last warn/error line so a failure (e.g. an existing proxy still
  // on 80/443, or a cert issue) reports WHY instead of a generic "not ready".
  let detail: string | undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/self-register/stream?id=${sessionId}`, {
      headers: { "X-Internal-Token": ensureInternalToken() },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok || !res.body) return { ok: false };
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
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
        if (!event) continue;
        if (event === "log" && dataRaw) {
          try {
            const d = JSON.parse(dataRaw);
            if (d.message) {
              const msg = String(d.message).replace(/\s+/g, " ");
              s.message(msg.slice(0, 68));
              if (d.level === "warn" || d.level === "error") detail = msg;
            }
          } catch {
            /* ignore */
          }
        } else if (event === "complete" && dataRaw) {
          try {
            const d = JSON.parse(dataRaw);
            ok = d.status === "completed";
            if (!ok && typeof d.error === "string") detail = d.error;
          } catch {
            /* ignore */
          }
        } else if (event === "end") {
          return { ok, detail };
        }
      }
    }
  } catch {
    return { ok, detail };
  }
  return { ok, detail };
}

/**
 * "Setup didn't finish" marker. Written once the wizard COMMITS the OS service
 * (so `serviceStatus().installed` flips true) and cleared only when setup runs
 * all the way to the end. If the wizard is interrupted in between — e.g. the
 * cloud-connect / domain step is cancelled or times out — this stays behind, so
 * the next `openship` resumes setup instead of showing the control panel as if
 * the install were finished. `openship up` never writes it (that path is a
 * complete install on its own), and pre-this-version installs never had one, so
 * neither is mistaken for interrupted.
 */
const SETUP_LOCK = join(OS_DIR, "setup-in-progress");

/** True when a prior wizard run installed the service but never completed. */
export function isSetupInProgress(): boolean {
  return existsSync(SETUP_LOCK);
}
function markSetupStarted(): void {
  mkdirSync(OS_DIR, { recursive: true });
  writeFileSync(SETUP_LOCK, "1");
}
function markSetupDone(): void {
  rmSync(SETUP_LOCK, { force: true });
}

/** Map the wizard's collected domain plan to the shared provision pipe's inputs. */
function wizardInputs(
  admin: { name: string; email: string; password: string },
  plan:
    | { type: "free"; slug: string; publicHost: string }
    | { type: "custom"; hostname: string }
    | { type: "byo"; hostname: string }
    | { type: "none" },
): InstallInputs {
  switch (plan.type) {
    case "free":
      return { admin, domain: { kind: "free", slug: plan.slug, publicHost: plan.publicHost } };
    case "custom":
      // Compose edge is a container; headlessProvision issues the cert via the
      // self-app project, so `edge` (host takeover) is a no-op here.
      return { admin, domain: { kind: "custom", hostname: plan.hostname, acmeEmail: admin.email, edge: "cancel" } };
    case "byo":
      return { admin, domain: { kind: "byo", hostname: plan.hostname } };
    default:
      return { admin, domain: { kind: "none" } };
  }
}

/** Shared "Openship is live" summary + clear the in-progress marker + outro. */
function finishSetup(opts: {
  liveUrl: string;
  dashPort: string;
  apiPort: string;
  adminEmail: string;
  cloudEmail: string | null;
  method: "compose" | "bare";
  byo: boolean;
}): void {
  saveInstanceUrl(opts.liveUrl);
  markSetupDone();
  const pad = (label: string) => chalk.dim(label.padEnd(11));
  log.success(chalk.bold("Openship is live"));
  log.message(
    `${pad("URL")}${chalk.bold(opts.liveUrl)}\n` +
      `${pad("Dashboard")}http://localhost:${opts.dashPort}\n` +
      `${pad("API")}http://localhost:${opts.apiPort}\n` +
      `${pad("Login")}${opts.adminEmail} ${chalk.dim("(email + password you set)")}\n` +
      (opts.cloudEmail
        ? `${pad("Cloud")}${chalk.dim("connected as ")}${opts.cloudEmail}${chalk.dim(" — free domain + mail only")}\n`
        : "") +
      `${pad("Status")}${chalk.green("running")} ${chalk.dim(opts.method === "compose" ? "· Docker Compose stack (restarts on boot)" : "· service (restarts on boot)")}`,
  );
  log.message(
    chalk.dim("Sign in with the email + password you just set. Openship appears under your Apps.\n") +
      chalk.dim("Change the domain, Openship Cloud, team, and everything else anytime in Settings.\n") +
      chalk.dim(`Locked out? Run ${chalk.reset("openship reset-admin-password")}${chalk.dim(" on this machine — resets your login without signing in.")}`),
  );
  outro(opts.byo ? chalk.dim("Point your reverse proxy at the dashboard port above.") : chalk.green("Happy shipping."));
}

/**
 * Shared local-edge preflight for a BARE install. A foreign proxy on 80/443 must
 * be dealt with before Openship can own the edge — and this is domain-AGNOSTIC:
 * a custom domain terminates TLS here, and a FREE domain has Cloud forward to :80
 * here, so BOTH need the local edge (and the same migrate/take-over/cancel
 * choice). This is the bare-mode twin of `openship up`'s compose `planAndApplyHostEdge`.
 * Returns proceed=false only when the operator chose to leave the proxy running.
 */
async function promptLocalEdgeTakeover(port: string): Promise<{
  proceed: boolean;
  edgeMigrate: boolean;
  edgeTakeover: boolean;
  staticRootOverrides?: Record<string, string>;
}> {
  const pf = await internalPost(port, "/api/system/self-edge/preflight", {});
  const status = pf.ok
    ? (pf.data?.status as
        | { classification: string; canProceedClean: boolean; occupants: Array<{ command?: string; port: number }> }
        | undefined)
    : undefined;
  // Clean (or unknown) edge → nothing to migrate/take over.
  if (!status || status.canProceedClean || !status.occupants?.length) {
    return { proceed: true, edgeMigrate: false, edgeTakeover: false };
  }
  const owner = status.occupants.map((o) => o.command ?? `port ${o.port}`).join(", ");
  const known = status.classification === "known";
  const sites = (pf.ok && Array.isArray(pf.data?.sites) ? pf.data.sites : []) as ImportedSite[];
  const warnings = (pf.ok && Array.isArray(pf.data?.warnings) ? pf.data.warnings : []) as string[];

  // Reuse the ONE shared presenter + prompt from edge-preflight.ts (same UI,
  // same EdgeAction vocabulary + default the compose host-edge preflight uses) —
  // no third hand-rolled copy of the migrate/take-over/cancel decision.
  renderEdgeConflict({ owner, sites, warnings });
  const action = await confirmEdgeAction({ owner, known, importable: sites.length });
  if (action === "cancel") return { proceed: false, edgeMigrate: false, edgeTakeover: false };

  // On migrate, remediate adopted static roots the edge can't reach (copy them into
  // its static mount host-side, this box being the host). The server's preflight
  // decided containerEdge (bare-vs-container) already, so trust its list — a bare
  // edge sees every path and returns none. See #456.
  let staticRootOverrides: Record<string, string> | undefined;
  if (action === "migrate") {
    const unreachable = (
      pf.ok && Array.isArray(pf.data?.unreachableStaticRoots) ? pf.data.unreachableStaticRoots : []
    ) as UnreachableStaticRoot[];
    staticRootOverrides = await remediateUnreachableStaticRoots({
      unreachable,
      executor: new LocalExecutor(),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
  }
  return {
    proceed: true,
    edgeMigrate: action === "migrate",
    edgeTakeover: action === "takeover",
    ...(staticRootOverrides ? { staticRootOverrides } : {}),
  };
}

export async function runWizard(): Promise<void> {
  const resuming = isSetupInProgress();
  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" setup")}`);
  if (resuming) {
    log.warn(
      "Your last setup didn't finish — picking it back up. Re-enter your details to complete it (or run `openship up` to just keep the server running).",
    );
  }
  log.message(
    chalk.dim(
      "Deploy Openship on this machine — a few questions, then it installs itself\nas a service, registers as an app, and prints the URL to log in.",
    ),
  );

  // 1. First-time admin — ALWAYS a local email + password, and the FIRST thing we
  //    ask. This is your instance login; the domain, Openship Cloud link, and every
  //    setting configured afterwards hang off this account. (Connecting Openship
  //    Cloud later only attaches the free domain + mail — it never becomes sign-in.)
  log.message(chalk.dim("First, your instance login (email + password) — this is how you sign in. Domain and Openship Cloud come next and never replace it."));
  const admin = await promptLocalAdmin();
  // Openship Cloud account attached for the free domain — display only, never the login.
  let cloudEmail: string | null = null;

  let publicUrl: string | undefined;
  let behindProxy = false;
  let managedEdge = false;
  // Domain wiring executed AFTER the service + admin are up.
  let domainPlan:
    | { type: "free"; slug: string; publicHost: string }
    | { type: "custom"; hostname: string }
    | { type: "byo"; hostname: string }
    | { type: "none" } = { type: "none" };

  // 2. Reachability + domain (settings that hang off the admin created above) — a
  //    small back-navigable state machine. Clack has no native "back", so each
  //    select offers "← Back" and captured inputs survive re-entry. Produces
  //    publicUrl / behindProxy / managedEdge / domainPlan.
  const canManage = process.platform === "linux";
  const BACK = "__back__";
  let slug = "";
  let customDomainInput = "";
  let byoDomainInput = "";
  let publicHost: string | null = null;

  // The server's public address — edge-proxy target + A-record hint. Auto-detect,
  // and PROMPT when that fails: the free/custom paths REQUIRE it (without it the
  // free registration 400s with "Could not resolve this server's public address").
  async function resolvePublicHost(): Promise<string> {
    if (publicHost) return publicHost;
    const sp = spinner();
    sp.start("Detecting this server's public IP");
    const detected = await detectPublicIp();
    if (detected) {
      sp.stop(`Public IP: ${chalk.bold(detected)}`);
      publicHost = detected;
      return detected;
    }
    sp.stop("Couldn't detect the public IP automatically.", 1);
    publicHost = ensure(
      await text({
        message: "This server's public IP or hostname",
        placeholder: "203.0.113.10",
        validate: (v) => (v?.trim() ? undefined : "Required — the edge proxy routes traffic to this address"),
      }),
    ).trim();
    return publicHost;
  }

  type DomainStage = "reach" | "type" | "free" | "custom" | "byo";
  let stage: DomainStage = "reach";

  log.message(chalk.dim("These are just starting choices — domain, Cloud, team, and the rest are all editable later in Settings."));

  planning: while (true) {
    if (stage === "reach") {
      const reach = ensure(
        await select({
          message: "How should this instance be reachable?",
          // Default to public — most people setting up on a server/VPS want a
          // domain + HTTPS; localhost-only is the deliberate opt-out.
          initialValue: "public",
          options: [
            { value: "public", label: "Public (server / VPS)", hint: "a domain + HTTPS, reachable from anywhere" },
            { value: "private", label: "This machine only", hint: "localhost — no domain, log in on this box" },
          ],
        }),
      );
      if (reach === "private") {
        domainPlan = { type: "none" };
        publicUrl = undefined;
        behindProxy = false;
        managedEdge = false;
        break planning;
      }
      stage = "type";
      continue;
    }

    if (stage === "type") {
      const domainType = ensure(
        await select({
          message: "How do you want a domain + HTTPS?",
          initialValue: "free",
          options: [
            { value: "free", label: "Free domain", hint: "name.opsh.io via Openship Cloud — HTTPS handled for you" },
            ...(canManage
              ? [{ value: "custom", label: "Custom domain", hint: "your domain + free Let's Encrypt on this box" }]
              : []),
            { value: "byo", label: "Bring your own", hint: "your domain, behind your own reverse proxy" },
            { value: BACK, label: "← Back" },
          ],
        }),
      );
      if (domainType === BACK) {
        stage = "reach";
        continue;
      }
      stage = domainType as DomainStage;
      continue;
    }

    if (stage === "free") {
      slug = ensure(
        await text({
          message: "Choose your subdomain",
          placeholder: "my-openship",
          initialValue: slug || undefined,
          validate: (v) => (v && SLUG_RE.test(v.trim().toLowerCase()) ? undefined : "Lowercase letters, digits, hyphens"),
        }),
      )
        .trim()
        .toLowerCase();
      const host = await resolvePublicHost();
      note(
        `${chalk.cyan(`https://${slug}.opsh.io`)}\n\n` +
          `  ${chalk.dim("served via")}  Openship Cloud edge  ${chalk.dim("→")}  ${chalk.cyan(host)}\n\n` +
          chalk.dim("Openship Cloud terminates HTTPS and forwards to this server."),
        "Confirm free domain",
      );
      const go = ensure(
        await select({
          message: "Create this free domain?",
          options: [
            { value: "go", label: "Create it" },
            { value: BACK, label: "← Back", hint: "change subdomain or IP" },
          ],
        }),
      );
      if (go === BACK) {
        stage = "type";
        continue;
      }
      publicUrl = `https://${slug}.opsh.io`;
      behindProxy = true; // Oblien's edge sets a trusted XFF
      domainPlan = { type: "free", slug, publicHost: host };
      break planning;
    }

    if (stage === "custom") {
      const raw = ensure(
        await text({
          message: "Your domain",
          placeholder: "ops.example.com",
          initialValue: customDomainInput || undefined,
          validate: (v) => (v && normalizeUrl(v) ? undefined : "Enter a valid domain"),
        }),
      );
      customDomainInput = raw;
      const url = normalizeUrl(raw)!.replace(/^http:/i, "https:");
      const hostname = new URL(url).hostname;
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        log.warn("Managed HTTPS installs OpenResty + certbot — that needs root. Re-run with sudo if it can't install.");
      }
      const host = await resolvePublicHost();
      note(
        `Add a DNS ${chalk.bold("A record")}:\n\n` +
          `  ${chalk.cyan(hostname)}  →  ${chalk.cyan(host)}\n\n` +
          chalk.dim("HTTPS is issued automatically once DNS resolves (it retries for a couple minutes)."),
        "DNS",
      );
      const go = ensure(
        await select({
          message: "A record added?",
          options: [
            { value: "go", label: "Continue", hint: "HTTPS provisions once DNS resolves — it retries" },
            { value: BACK, label: "← Back", hint: "change the domain" },
          ],
        }),
      );
      if (go === BACK) {
        stage = "type";
        continue;
      }
      publicUrl = url;
      managedEdge = true;
      behindProxy = true; // OpenResty terminates TLS + sets a trusted XFF
      domainPlan = { type: "custom", hostname };
      break planning;
    }

    // stage === "byo"
    const raw = ensure(
      await text({
        message: "Your domain (served behind your proxy)",
        placeholder: "ops.example.com",
        initialValue: byoDomainInput || undefined,
        validate: (v) => (v && normalizeUrl(v) ? undefined : "Enter a valid domain"),
      }),
    );
    byoDomainInput = raw;
    const url = normalizeUrl(raw)!;
    const hostname = new URL(url).hostname;
    if (url.startsWith("http://")) {
      log.warn("Serving over plain HTTP sends passwords in cleartext — put HTTPS in front before real use.");
    }
    note(
      `${chalk.cyan(url)}\n\n` + chalk.dim("Point your reverse proxy at the dashboard port shown at the end."),
      "Confirm",
    );
    const go = ensure(
      await select({
        message: "Continue?",
        options: [
          { value: "go", label: "Continue" },
          { value: BACK, label: "← Back", hint: "change the domain" },
        ],
      }),
    );
    if (go === BACK) {
      stage = "type";
      continue;
    }
    publicUrl = url;
    behindProxy = true;
    domainPlan = { type: "byo", hostname };
    break planning;
  }

  // 3. Choose how to run Openship. On a Linux server use the Docker Compose stack
  //    (containerized edge on 80/443 that hosts apps on THIS box, with real
  //    image-pull progress) — the same install `openship up` picks — auto-installing
  //    Docker via the same toolchain the deploy pipeline uses. macOS/Windows (no
  //    host-net Docker) and a failed Docker ensure fall back to the bare service.
  let method: "compose" | "bare" = "bare";
  if (process.platform === "linux") {
    // Say what's ACTUALLY missing. "Docker isn't installed" on a box that has
    // Docker but no Compose plugin (Debian's docker.io) sent operators chasing
    // the wrong problem, and re-running get.docker.com for a daemon that's merely
    // unreachable can't help — it just rewrites their docker repo config.
    const gap = dockerGap();
    if (!gap) {
      method = "compose";
    } else if (!gap.installable) {
      log.warn(`${gap.summary} — using the bare process service instead.`);
      if (gap.hint) log.info(gap.hint);
      method = "bare";
    } else {
      log.step(`${gap.summary} — installing via get.docker.com…`);
      method = (await ensureDocker({ onNotice: (line) => log.info(line) })) ? "compose" : "bare";
      if (method === "bare") {
        log.warn("Couldn't install Docker automatically — falling back to the bare process service.");
      }
    }
  }

  const uiTag = `v${__CLI_VERSION__}`;
  // Bare runs the downloaded dashboard bundle; Compose ships the dashboard inside
  // the image, so only the bare path pulls the dist (Compose shows pull progress).
  if (method === "bare") {
    const dl = spinner();
    dl.start("Pulling the Openship dist from GitHub");
    try {
      await ensureDashboard({
        tag: uiTag,
        onProgress: (received, total) => {
          if (total) dl.message(`Pulling the Openship dist from GitHub — ${Math.round((received / total) * 100)}%`);
        },
      });
      dl.stop("Openship dist ready.");
    } catch (e) {
      dl.stop(`Couldn't pull the Openship dist: ${(e as Error).message}`, 1);
      log.info("Check your network / that this release published its dashboard asset, then re-run `openship`.");
      process.exit(1);
    }
  }

  // From here the service/stack exists, so serviceStatus().installed is true even
  // if the user bails at the cloud/domain step below — mark setup in-progress so
  // the next launch resumes here instead of jumping to the control panel.
  markSetupStarted();

  const s = spinner();
  let started: { port: string; dashPort: string; publicUrl?: string };
  let provisionToken: string | undefined;
  // Host-edge takeover state (compose only): what the operator chose, plus the
  // sites/certs to hand the api once the container edge is up.
  let edgeAction: "migrate" | "takeover" | "cancel" | undefined;
  let migratedSites: ImportedSite[] | undefined;
  let migratedCertPems: Record<string, { certPem: string; keyPem: string }> | undefined;
  let migratedStaticRootOverrides: Record<string, string> | undefined;
  // Host control is a SECURITY decision, so it's shown rather than assumed — but
  // pre-selected to "allow", because a single-box install needs it (:80/:443
  // takeover, host port scans, the host terminal) and a hardening prompt that
  // blocks the happy path just gets clicked through. Declining is a real posture:
  // this box then manages only REMOTE servers.
  let allowHostControl = true;
  if (method === "compose") {
    allowHostControl =
      ensure(
        await select({
          message: "Let Openship operate this machine's OS?",
          initialValue: "allow",
          options: [
            {
              value: "allow",
              label: "Allow (recommended)",
              hint: "needed to deploy to THIS box: take over :80/:443, scan ports, host terminal",
            },
            {
              value: "deny",
              label: "No host control",
              hint: "manage only remote servers — no host key is created, host ops refuse",
            },
          ],
        }),
      ) === "allow";
    if (!allowHostControl) {
      log.message(
        chalk.dim(
          "  No host key will be created or mounted, and this box won't be offered as a deploy target.\n" +
            "  The Docker socket stays mounted (deployments need it), so this is defense in depth, not isolation.",
        ),
      );
    }
  }
  if (method === "compose") {
    // Ports are a preference, not a fixture: the stack publishes them on the host,
    // so a busy 4000/3001 would fail `up` outright. Resolved once here and passed to
    // both compose steps (they each render `.env`, so they must agree).
    const ports = await resolveComposePorts({});
    const apiPort = String(ports.api);
    const dashboardPort = String(ports.dashboard);
    const moved = portMoveNotice(ports, composeTrustedOriginUrls());
    if (moved.length) log.info(moved.join("\n"));
    // Fetch FIRST, cut over second — same rule as `openship up`. Pulling after the
    // preflight stops a foreign proxy keeps the box dark for the whole download, and
    // a failed pull takes their sites down for a problem that never reached them.
    log.step(
      sourceBuildDir()
        ? "Building the Openship images before touching :80/:443 (first run takes a few minutes)…"
        : "Pulling images before touching :80/:443…",
    );
    if (
      !composePrefetch({
        apiPort,
        dashboardPort,
        publicUrl,
        trustProxy: behindProxy,
        version: __CLI_VERSION__,
        noHostControl: !allowHostControl,
      })
    ) {
      cancel("Couldn't fetch the Openship images — nothing on this box was changed.");
      process.exit(1);
    }

    // A foreign proxy already on 80/443? Migrate/take it over first (interactive)
    // so the container edge can bind — the same host-edge pipe `openship up` uses.
    const edgePlan = await planAndApplyHostEdge({});
    if (!edgePlan.proceed) {
      cancel(
        edgePlan.blockedBy
          ? `Can't take over the edge: ${edgePlan.blockedBy}. Nothing was started.`
          : "Left the existing proxy on 80/443 running — re-run and choose migrate/takeover when ready.",
      );
      process.exit(edgePlan.blockedBy ? 1 : 0);
    }
    // Kept outside this branch so the health-check failure below can roll the
    // takeover back, and so the post-up import knows what to register.
    edgeAction = edgePlan.action;
    migratedSites = edgePlan.sites;
    migratedCertPems = edgePlan.certPems;
    migratedStaticRootOverrides = edgePlan.staticRootOverrides;
    log.step("Starting the Docker Compose stack…");
    const up = await composeUp({
      // Prefetched above, before the preflight stopped anything.
      alreadyFetched: true,
      apiPort,
      dashboardPort,
      publicUrl,
      trustProxy: behindProxy,
      version: __CLI_VERSION__,
      noHostControl: !allowHostControl,
    });
    if (!up.ok) {
      // The preflight stopped + disabled the operator's proxy to free 80/443. The
      // stack isn't coming up, so restore it rather than leaving the box dark.
      if (edgePlan.action && (await rollbackHostEdge())) {
        log.warn("Restored the previous proxy on 80/443 — your existing sites are serving again.");
      }
      log.error("The Docker Compose stack didn't come up. Run `openship up --compose` to see the error.");
      process.exit(1);
    }
    started = { port: up.apiPort, dashPort: up.dashPort, publicUrl };
    provisionToken = composeInternalToken() ?? undefined;
    s.start("Waiting for the Openship API");
  } else {
    s.start("Installing Openship as a service");
    try {
      started = await startService(
        { publicUrl, trustProxy: behindProxy, managedEdge, acmeEmail: managedEdge ? admin.email : undefined, uiVersion: uiTag },
        { quiet: true },
      );
    } catch (e) {
      s.stop("Couldn't install the service.", 1);
      log.error((e as Error).message);
      log.info("Run `openship up --foreground` to run it attached and see the error.");
      process.exit(1);
    }
    s.message("Waiting for the Openship API");
  }

  if (!(await waitHealthy(started.port))) {
    s.stop("Openship didn't become healthy in time.", 1);
    if (method === "compose" && edgeAction && (await rollbackHostEdge())) {
      log.warn("Restored the previous proxy on 80/443 — your existing sites are serving again.");
    }
    const reason = lastServiceError();
    if (reason) log.error(reason);
    if (reason && /lock/i.test(reason)) {
      log.info("The database is locked by another instance — run `openship stop`, then re-run `openship`.");
    } else {
      log.info(
        method === "compose"
          ? "Run `openship up --compose` to see the error."
          : "Run `openship up --foreground` to run it attached and see the error.",
      );
    }
    process.exit(1);
  }

  if (method === "compose") {
    // Reuse the SAME provision pipe as `openship up` (admin + domain via
    // self-register against the running stack). Keep the interactive Openship
    // Cloud connect for a free domain; the container edge owns HTTPS.
    s.message("Starting the Openship dashboard");
    await waitDashboard(started.dashPort);
    s.stop("Deployed.");

    // Migrate, phase 2 — the container edge exists now, so re-register the
    // foreign proxy's sites into it (same helper `openship up` uses). Without
    // this, "Migrate N sites & take over" would take the ports and serve nothing
    // for those hostnames.
    if (edgeAction === "migrate" && migratedSites?.length) {
      const imported = await importMigratedSites(
        started.port,
        migratedSites,
        migratedCertPems,
        migratedStaticRootOverrides,
      );
      if (!imported.ok) {
        log.warn(
          `Your ${migratedSites.length} existing site${migratedSites.length === 1 ? "" : "s"} ` +
            "aren't served yet — re-run `openship up` to retry the import.",
        );
      }
    }
    if (edgeAction) await completeHostEdge();

    let liveUrl = publicUrl ?? `http://localhost:${started.dashPort}`;
    if (domainPlan.type === "free") {
      const cloud = await connectOpenshipCloud(started.port, provisionToken);
      if (cloud) cloudEmail = cloud.email;
      else
        log.warn(
          "Openship Cloud wasn't connected — skipping the free domain. Your local admin login still works; add it later in Settings → Cloud.",
        );
    }
    const result = await headlessProvision({
      port: started.port,
      dashPort: started.dashPort,
      inputs: wizardInputs(admin, domainPlan),
      token: provisionToken,
      method: "compose",
      onLog: (msg) => log.message(chalk.dim(msg)),
      // .opsh.io is a SHARED zone, and Cloud only connects after the stack is up —
      // so a taken subdomain can't be detected at prompt time. Recover here, where
      // we still have a TTY, instead of ending the run with no domain.
      onSlugTaken: async (taken) => {
        log.warn(`"${taken}.opsh.io" is already taken.`);
        const next = await text({
          message: "Choose a different subdomain (or leave empty to skip the free domain)",
          placeholder: "my-openship",
          validate: (v) => {
            const value = (v ?? "").trim().toLowerCase();
            if (!value) return undefined; // empty = skip
            return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)
              ? undefined
              : "Lowercase letters, digits and hyphens only";
          },
        });
        if (isCancel(next)) return null;
        const value = String(next ?? "").trim().toLowerCase();
        return value || null;
      },
    });
    if (result.liveUrl) liveUrl = result.liveUrl;
    // The domain FAILED: don't present the planned hostname as the live URL. The
    // summary used to print `https://<slug>.opsh.io` for a domain that was never
    // created, because liveUrl was seeded from the plan and only overwritten on
    // success — so a hard failure read as a success.
    else if (!result.domainRegistered) liveUrl = `http://localhost:${started.dashPort}`;
    for (const w of result.warnings) log.warn(w);
    finishSetup({
      liveUrl,
      dashPort: started.dashPort,
      apiPort: started.port,
      adminEmail: admin.email,
      cloudEmail,
      method: "compose",
      byo: domainPlan.type === "byo",
    });
    return;
  }

  // Always create the local admin now — before any cloud connect — so the instance
  // login is the email + password you set, never derived from Openship Cloud.
  s.message("Creating your admin account");
  const adminRes = await bootstrapAdmin(started.port, admin);
  if (!adminRes.ok) {
    s.stop(`Couldn't create the admin account: ${adminRes.message}`, 1);
    process.exit(1);
  }
  if (adminRes.message === "already-exists") {
    // This data dir already had an admin (a re-run, or a prior cloud/dirty setup).
    // bootstrap-admin is one-shot and won't touch it, so force the box to LOCAL
    // login with the credentials just entered — reset sets the password, revokes
    // stale sessions, and flips authMode back to local. Without this, a box that
    // was previously cloud-linked keeps showing "Sign in with Openship" instead of
    // the email + password form.
    s.message("Applying your admin login");
    const rr = await internalPost(started.port, "/api/system/reset-admin-password", {
      email: admin.email,
      name: admin.name,
      password: admin.password,
    });
    if (!rr.ok) {
      s.stop(`Couldn't set your admin login: ${rr.data?.error || "failed"}`, 1);
      process.exit(1);
    }
  }
  s.message(`Admin ready for ${admin.email}`);

  // The dist is already cached, so the dashboard only has to boot. Wait for it so
  // "live" is truthful (best-effort — the API already serves regardless).
  s.message("Starting the Openship dashboard");
  await waitDashboard(started.dashPort);
  s.stop("Deployed.");

  // 4. Register the control plane as an app + attach its domain (reuse Openship's
  //    own app + domain pipeline). Runs for every mode so it shows under Apps.
  let liveUrl = publicUrl ?? `http://localhost:${started.dashPort}`;
  const port = started.port;

  if (domainPlan.type === "free") {
    // Connect Openship Cloud — a SEPARATE step from login. Authorize in the browser
    // (link printed on the terminal); it only attaches the free .opsh.io domain +
    // mail. The backend links it to the local admin already created above WITHOUT
    // changing the login method. If declined, the box still works on your local
    // login — we just skip the free domain.
    const cloud = await connectOpenshipCloud(port);
    if (!cloud) {
      log.warn("Openship Cloud wasn't connected — skipping the free domain. Your local admin login still works; add the domain later in Settings → Cloud.");
      await internalPost(port, "/api/system/self-register", { domainType: "byo" });
    } else {
      cloudEmail = cloud.email;
      // Cloud forwards <slug>.opsh.io → :80 on THIS box, so the box needs a local
      // edge listening there — including taking over a foreign proxy on 80/443.
      // The SAME shared preflight the custom path runs; Cloud terminates TLS, so
      // no cert is issued (self-register gets localEdge + the takeover choice).
      const edge = await promptLocalEdgeTakeover(port);
      if (!edge.proceed) {
        log.warn(
          "Left the existing proxy on 80/443 running — a free domain forwards to :80 here, so it " +
            "won't serve until Openship owns that port. Re-run setup and choose migrate / take over.",
        );
      }
      // Reuse the SAME provision pipe as `openship up` + the compose wizard: its
      // free branch owns the shared-zone slug-taken retry (onSlugTaken) AND the
      // localEdge host-edge streaming — no hand-rolled loop here. bootstrapAdmin
      // already ran above; headlessProvision's bootstrap is idempotent.
      const result = await headlessProvision({
        port,
        dashPort: started.dashPort,
        token: provisionToken,
        method: "bare",
        inputs: {
          admin,
          domain: {
            kind: "free",
            slug: domainPlan.slug,
            publicHost: domainPlan.publicHost,
            // Bare needs a local :80 edge for Cloud to forward to; skip only when
            // the operator declined the takeover (their proxy keeps 80/443).
            localEdge: edge.proceed,
            edgeTakeover: edge.edgeTakeover,
            edgeMigrate: edge.edgeMigrate,
            ...(edge.staticRootOverrides ? { staticRootOverrides: edge.staticRootOverrides } : {}),
          },
        },
        onLog: (msg) => log.message(chalk.dim(msg)),
        onSlugTaken: async (taken) => {
          log.warn(`"${taken}.opsh.io" is already taken.`);
          const next = await text({
            message: "Choose a different subdomain (or leave empty to skip the free domain)",
            placeholder: "my-openship",
            validate: (v) => (!v || SLUG_RE.test(v.trim().toLowerCase()) ? undefined : "Lowercase letters, digits, hyphens"),
          });
          return isCancel(next) || !next.trim() ? null : next.trim().toLowerCase();
        },
      });
      if (result.liveUrl) liveUrl = result.liveUrl;
      for (const w of result.warnings) log.warn(w);
    }
  } else if (domainPlan.type === "custom") {
    // Managed HTTPS needs ports 80/443 — the SAME shared preflight the free path
    // runs asks migrate / take over / cancel when a foreign proxy owns them.
    const edge = await promptLocalEdgeTakeover(port);
    const proceedCustom = edge.proceed;
    const edgeTakeover = edge.edgeTakeover;
    const edgeMigrate = edge.edgeMigrate;

    // proceed=false covers BOTH the explicit "Cancel — leave it running" choice
    // and ESC/Ctrl-C (the shared confirmEdgeAction maps isCancel → "cancel").
    // Either way we DON'T abort the run — the stack is already up, so we register
    // the instance as byo (front it with your own proxy) and continue, rather than
    // leaving a deployed-but-unregistered box. The warn below tells the operator.
    if (!proceedCustom) {
      log.warn(
        "Left the existing proxy on 80/443 running. Registering Openship without managed HTTPS — " +
          "front it with your proxy, or re-run setup to take over.",
      );
      await internalPost(port, "/api/system/self-register", {
        domainType: "byo",
        hostname: domainPlan.hostname,
      });
      liveUrl = `https://${domainPlan.hostname}`;
    } else {
      const res = await internalPost(port, "/api/system/self-register", {
        domainType: "custom",
        hostname: domainPlan.hostname,
        dashPort: Number(started.dashPort),
        acmeEmail: admin?.email,
        edgeTakeover,
        edgeMigrate,
        ...(edge.staticRootOverrides ? { staticRootOverrides: edge.staticRootOverrides } : {}),
      });
      if (res.ok && res.data?.sessionId) {
        const s2 = spinner();
        s2.start("Issuing HTTPS certificate (OpenResty + Let's Encrypt)");
        const { ok: done, detail } = await streamProvision(port, res.data.sessionId, s2);
        liveUrl = res.data.url ?? liveUrl;
        if (done) s2.stop(`HTTPS ready: ${liveUrl}`);
        else {
          s2.stop("HTTPS isn't ready yet — it retries on reboot; the site serves over HTTP meanwhile.", 1);
          if (detail) log.warn(detail);
        }
      } else {
        log.warn(`Couldn't start domain provisioning: ${res.data?.error || "failed"}`);
      }
    }
  } else if (domainPlan.type === "byo") {
    const res = await internalPost(port, "/api/system/self-register", {
      domainType: "byo",
      hostname: domainPlan.hostname,
    });
    if (res.ok && res.data?.url) liveUrl = res.data.url;
  } else {
    // Private — still register as an app so it appears under Apps.
    await internalPost(port, "/api/system/self-register", { domainType: "byo" });
  }

  finishSetup({
    liveUrl,
    dashPort: started.dashPort,
    apiPort: started.port,
    adminEmail: admin.email,
    cloudEmail,
    method: "bare",
    byo: domainPlan.type === "byo",
  });
}

/**
 * Control panel for an ALREADY-SET-UP box — what bare `openship` shows instead of
 * re-running setup once a service is installed. Manage the running instance
 * (open / status / start-stop-restart / reset login / reconfigure) rather than
 * starting over.
 */
export async function runControl(): Promise<void> {
  const svc = serviceStatus();
  const isCompose = readInstallMethod() === "compose";
  // A compose install has no systemd/launchd unit for serviceStatus() to read,
  // so derive liveness + drive start/stop/restart through docker compose instead.
  const running = isCompose ? composeRunning() : svc.running;
  const managerLabel = isCompose ? "docker compose" : svc.kind === "unsupported" ? "none" : svc.kind;
  const ports = readStoredPorts();
  const apiPort = String(storedApiPort());
  const dashUrl = `http://localhost:${storedDashboardPort()}`;
  const publicUrl = readInstanceUrl();
  // The real front door: the public domain if one was set, else the local dashboard.
  const primaryUrl = publicUrl && !/^https?:\/\/localhost/i.test(publicUrl) ? publicUrl : dashUrl;

  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" control")}`);
  note(
    `${chalk.dim("URL".padEnd(11))}${chalk.bold(primaryUrl)}\n` +
      `${chalk.dim("Service".padEnd(11))}${running ? chalk.green("running") : chalk.yellow("stopped")}\n` +
      `${chalk.dim("Dashboard".padEnd(11))}${dashUrl}\n` +
      (ports.api ? `${chalk.dim("API".padEnd(11))}http://localhost:${ports.api}\n` : "") +
      `${chalk.dim("Manager".padEnd(11))}${managerLabel}`,
    "Openship is already set up",
  );

  // Crash-looping on a corrupt DB is the one case where "Start" won't help —
  // surface Repair first and say so, instead of leaving the user guessing.
  const corrupted = looksCorrupted();
  if (corrupted) {
    note(chalk.red("The service is installed but keeps failing to start — the database looks corrupted."), "Needs repair");
  }

  const action = ensure(
    await select({
      message: "What would you like to do?",
      options: [
        ...(corrupted ? [{ value: "repair", label: "Repair database", hint: "backup → heal → verify" }] : []),
        { value: "open", label: "Open the dashboard" },
        running
          ? { value: "restart", label: "Restart the service" }
          : { value: "start", label: "Start the service" },
        { value: "stop", label: "Stop the service", hint: "won't restart on boot" },
        ...(corrupted ? [] : [{ value: "repair", label: "Repair database", hint: "backup → heal a corrupt DB" }]),
        { value: "reset", label: "Reset admin password", hint: "sets a local email + password login" },
        { value: "reconfigure", label: "Re-run setup", hint: "reconfigure domain / cloud / admin" },
        { value: "quit", label: "Quit" },
      ],
    }),
  );

  switch (action) {
    case "repair": {
      const res = await runRepair();
      outro(res.healed ? chalk.green(res.detail) : chalk.yellow(res.detail));
      return;
    }
    case "open":
      await open(primaryUrl).catch(() => {});
      outro(chalk.dim(`Opening ${primaryUrl}`));
      return;
    case "start": {
      if (isCompose) {
        const ok = composeStart();
        outro(ok ? chalk.green("Started.") : chalk.yellow("Couldn't start the stack — run `openship up` to see the error."));
        return;
      }
      await startService({});
      return;
    }
    case "restart": {
      if (isCompose) {
        const ok = composeRestart();
        outro(ok ? chalk.green("Restarted.") : chalk.yellow("Couldn't restart the stack."));
        return;
      }
      const r = restartService();
      outro(r.restarted ? chalk.green("Restarted.") : chalk.yellow(r.detail));
      return;
    }
    case "stop": {
      if (isCompose) {
        const ok = composeDown();
        outro(ok ? chalk.green("Stopped. Won't restart on boot.") : chalk.yellow("Couldn't stop the stack."));
        return;
      }
      const r = stopService();
      outro(chalk.green(`Stopped. ${chalk.dim(r.detail)}`));
      return;
    }
    case "reset": {
      const pw = ensure(
        await password({ message: "New admin password", validate: (v) => (v && v.length >= 8 ? undefined : "At least 8 characters") }),
      );
      const rr = await internalPost(apiPort, "/api/system/reset-admin-password", { password: pw });
      outro(
        rr.ok
          ? chalk.green(`Password reset. Sign in at ${dashUrl} with your email + new password.`)
          : chalk.red(`Couldn't reset: ${rr.data?.error || "failed"}`),
      );
      return;
    }
    case "reconfigure":
      await runWizard();
      return;
    default:
      outro(chalk.dim("Nothing changed."));
  }
}
