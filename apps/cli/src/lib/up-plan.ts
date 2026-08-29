/**
 * `openship up --dry-run`: what the run WOULD do, computed without doing any of it.
 *
 * The flag used to mean "print the systemd unit and exit" — but the decision about
 * which unit to print came AFTER the install-method choice, and on Linux that
 * choice calls `ensureDocker()`. So previewing an install on a fresh Debian box
 * installed ~150 MB of Docker packages and enabled the daemon before printing
 * anything (#436): the machine you'd run a preview on is exactly the machine an
 * unattended install is least welcome on.
 *
 * So the whole preview lives here, off the mutating path, and every input is a
 * READ: `dockerInstallPreview` instead of `ensureDocker`, `composePlan` instead of
 * `materialize`, `previewHostEdge` instead of `planAndApplyHostEdge`, and port
 * resolution with `persist: false`. Probing a port and reading a proxy's config is
 * as far as it goes; nothing is created, downloaded, stopped or enabled.
 */
import chalk from "chalk";

import {
  composePlan,
  dockerInstallPreview,
  renderPgDataRefusal,
  renderSecretRotationRefusal,
  resolveComposePorts,
  type ComposePlan,
  type DockerInstallPreview,
} from "./compose";
import { DASHBOARD_CACHE } from "./dashboard";
import { previewHostEdge, type EdgePreview } from "./edge-preflight";
import { DEFAULT_REPO, SOURCE_CHECKOUT_DIR, SOURCE_DIST_DIR } from "./from-source";
import { AUTH_SECRET_FILE, DATA_DIR, INTERNAL_TOKEN_FILE, LOG_DIR } from "./paths";
import { PORTS_FILE, resolvePorts, type ResolvedPorts } from "./ports";
import { installStepFor, preview as previewService, type ServiceKind } from "./service";

/** How `up` would run: install a supervised service, or stay attached. */
export type UpMode = "service" | "foreground" | "from-source";

export interface UpPlanOpts {
  bare?: boolean;
  compose?: boolean;
  foreground?: boolean;
  fromSource?: boolean;
  source?: string;
  ref?: string;
  repo?: string;
  port?: string;
  dashboardPort?: string;
  dataDir?: string;
  ui?: boolean;
  uiVersion?: string;
  trustProxy?: boolean;
  host?: string;
  managedEdge?: boolean;
  acmeEmail?: string;
  hostControl?: boolean;
  hostSshHost?: string;
  hostSshPort?: string;
  hostSshUser?: string;
  /** Openship Mail install (OPENSHIP_PRODUCT=mail / `--mail` in the unit's argv). */
  mail?: boolean;
  /** Already normalized + merged with the install's saved URL by the caller. */
  publicUrl?: string;
  /** Previewing `--reset-secrets`, so the plan shouldn't show the refusal it waives. */
  resetSecrets?: boolean;
}

export interface UpPlan {
  mode: UpMode;
  method: "compose" | "bare";
  /** Why that method — the flag, the platform, or Docker's state. */
  methodReason: string;
  docker: DockerInstallPreview;
  ports: ResolvedPorts;
  publicUrl?: string;
  /** Compose stack that would be written (compose method only). */
  compose?: ComposePlan;
  /** Service definition that would be installed (bare service mode only). */
  service?: { kind: ServiceKind; path: string; content: string };
  /** Who holds :80/:443 today (compose method on Linux only). */
  edge?: EdgePreview;
  fromSource?: { ref: string; repo?: string; sourceDir?: string };
  /** Paths this run would create or overwrite. */
  writes: string[];
  /** Commands it would execute, in order. */
  runs: string[];
}

/**
 * Which install method a service-mode `up` lands on, given whether Docker is (or
 * could be made) usable. THE decision — `openship up` calls this too, with
 * `dockerUsable` from a real `ensureDocker()`, so the preview can never name a
 * different method than the run.
 */
export function planMethod(
  opts: { bare?: boolean; compose?: boolean },
  dockerUsable: boolean,
): { method: "compose" | "bare"; reason: string } {
  if (opts.bare) return { method: "bare", reason: "--bare was passed" };
  if (opts.compose) return { method: "compose", reason: "--compose was passed" };
  // Compose is the default only where it can actually work: the edge container
  // binds host :80/:443 through host networking, which Docker Desktop lacks.
  if (process.platform !== "linux") {
    return {
      method: "bare",
      reason: `the compose edge needs host networking, which Docker Desktop on ${process.platform} doesn't provide`,
    };
  }
  return dockerUsable
    ? { method: "compose", reason: "the default on Linux when Docker is usable" }
    : { method: "bare", reason: "Docker isn't usable here, so `up` falls back to the process service" };
}

/** Everything `--dry-run` reports. Read-only: see the file header. */
export async function planUp(opts: UpPlanOpts): Promise<UpPlan> {
  const mode: UpMode = opts.fromSource || opts.source ? "from-source" : opts.foreground ? "foreground" : "service";
  // Attached modes (--foreground, --from-source) run the bundled API + downloaded
  // dashboard as child processes — they never touch compose.
  const attached = mode !== "service";
  const docker = dockerInstallPreview();
  // Usable now, or usable after the install a real run would perform. The group
  // caveat is surfaced in the render, not smuggled into the decision.
  const dockerUsable = docker.gap === null || docker.wouldInstall;
  const { method, reason } = attached
    ? { method: "bare" as const, reason: `--${mode === "foreground" ? "foreground" : "from-source"} runs attached (no service, no compose)` }
    : planMethod(opts, dockerUsable);

  const plan: UpPlan = {
    mode,
    method,
    methodReason: reason,
    docker,
    ports:
      method === "compose"
        ? await resolveComposePorts({ api: opts.port, dashboard: opts.dashboardPort }, { persist: false })
        : await resolvePorts(
            {
              api: opts.port ? Number(opts.port) : undefined,
              dashboard: opts.dashboardPort ? Number(opts.dashboardPort) : undefined,
            },
            { persist: false },
          ),
    ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
    writes: [],
    runs: [],
  };

  if (mode === "from-source") {
    plan.fromSource = {
      ref: opts.source ? "local" : (opts.ref || "main").trim(),
      ...(opts.source ? { sourceDir: opts.source } : { repo: opts.repo || DEFAULT_REPO }),
    };
  }

  if (method === "compose") {
    const stack = composePlan({
      apiPort: String(plan.ports.api),
      dashboardPort: String(plan.ports.dashboard),
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      ...(opts.trustProxy ? { trustProxy: true } : {}),
      ...(opts.hostControl === false ? { noHostControl: true } : {}),
      ...(opts.hostSshHost ? { hostSshHost: opts.hostSshHost } : {}),
      ...(opts.hostSshPort ? { hostSshPort: opts.hostSshPort } : {}),
      ...(opts.hostSshUser ? { hostSshUser: opts.hostSshUser } : {}),
      ...(opts.resetSecrets ? { resetSecrets: true } : {}),
      ...(opts.mail ? { mail: true } : {}),
    });
    plan.compose = stack;
    // Only where the probe means something: the host-net edge (and the :80/:443
    // contention) is Linux-only, so reporting "free" off Linux would be a claim we
    // never actually checked.
    if (process.platform === "linux") plan.edge = await previewHostEdge();
    plan.writes.push(
      stack.composeFile,
      `${stack.envFile}${stack.newSecrets.length ? `  (generates ${stack.newSecrets.join(", ")})` : ""}`,
      ...(stack.buildFile ? [stack.buildFile] : []),
      ...(stack.hostChannel
        ? [
            stack.hostChannel.keyPath,
            `${stack.hostChannel.authKeysPath}  (authorizes that key for ${stack.hostChannel.user}'s host ops; --no-host-control skips it)`,
            // Say which route to root this channel will take, rather than repeating a root
            // warning at a box that reaches root perfectly well via sudo. `sudo` is a
            // supported shape now, not a degradation, and the preview is where an operator
            // decides whether that is what they wanted.
            ...(stack.hostChannel.elevation === "sudo"
              ? [
                  `logs in as ${stack.hostChannel.user} and elevates with sudo for root host ops (no root login is created)`,
                ]
              : []),
            ...(stack.hostChannel.rootUnavailable
              ? [
                  "⚠ host control needs root — this user isn't root and passwordless sudo isn't available, so mail/edge host ops will fail (re-run as root, or enable passwordless sudo, to fix)",
                ]
              : []),
            // A plan that named one account and then settled on another would read as the
            // plan being wrong, and this run genuinely cannot know which: only a dial can
            // establish whether sshd accepts the first account, and dialing means writing
            // the key a dry run exists not to write (#527, previewHostChannel).
            ...(stack.hostChannel.fallbacks?.length
              ? [
                  `if this host's sshd refuses that account, falls back to ${stack.hostChannel.fallbacks.join(", ")} (pin one with --host-ssh-user)`,
                ]
              : []),
          ]
        : []),
      ...stack.mountDirs.map((d) => `${d}/  (edge routing state + certs)`),
      stack.installMethodFile,
    );
    plan.runs.push(
      stack.buildDir
        ? `docker compose pull postgres redis && docker compose build  (from ${stack.buildDir})`
        : `docker compose pull  (postgres, redis, api, dashboard, edge — several hundred MB)`,
      `docker compose up -d  (the edge container binds host :80 and :443)`,
    );
  } else {
    plan.writes.push(PORTS_FILE, `${LOG_DIR}/`);
    if (mode === "service") {
      const svc = previewService({
        port: opts.port,
        dataDir: opts.dataDir,
        dashboardPort: opts.dashboardPort,
        ui: opts.ui,
        uiVersion: opts.uiVersion,
        publicUrl: opts.publicUrl,
        trustProxy: opts.trustProxy || opts.managedEdge,
        host: opts.host,
        managedEdge: opts.managedEdge,
        acmeEmail: opts.acmeEmail,
        mail: opts.mail,
      });
      plan.service = svc;
      if (svc.path) plan.writes.push(svc.path);
      plan.runs.push(installStepFor(svc.kind));
    }
    plan.writes.push(
      AUTH_SECRET_FILE,
      INTERNAL_TOKEN_FILE,
      `${opts.dataDir || DATA_DIR}/  (embedded Postgres)`,
    );
    if (opts.ui !== false) {
      plan.runs.push(`download the dashboard bundle → ${DASHBOARD_CACHE}  (--no-ui skips it)`);
    }
    if (mode === "from-source") {
      const src = plan.fromSource!;
      plan.runs.unshift(
        ...(src.sourceDir
          ? [`build the checkout at ${src.sourceDir}`]
          : [`git clone/fetch ${src.repo} @ ${src.ref} → ${SOURCE_CHECKOUT_DIR}`]),
        `bun install + build the release dist → ${SOURCE_DIST_DIR}  (compiles the dashboard)`,
      );
    }
    if (opts.managedEdge) {
      plan.runs.push(
        "install OpenResty + issue a Let's Encrypt certificate on this box (--managed-edge)",
      );
    }
    if (attached) {
      plan.runs.push("run the API + dashboard attached to this terminal until Ctrl-C");
    }
  }

  return plan;
}

/** The operator-facing preview. One string so callers print it in one write. */
export function renderUpPlan(plan: UpPlan): string {
  const L: string[] = [];
  const head = (s: string) => L.push("", chalk.bold(`  ${s}`));
  const item = (s: string) => L.push(chalk.dim(`    ${s}`));

  L.push(
    "",
    chalk.cyan("  Dry run — nothing on this machine has been changed."),
    chalk.dim(`  ${methodLabel(plan)} · ${plan.methodReason}`),
  );

  head("Docker");
  const { docker } = plan;
  if (!docker.gap) {
    item("already installed and usable — nothing to install.");
  } else if (docker.wouldInstall) {
    item(chalk.yellow(`${docker.gap.summary}. A real run WOULD install it:`));
    item(`  ${docker.installCommand}`);
    item("~150 MB of packages, and it enables the docker service on this box.");
    if (plan.method === "compose") item("`openship up --bare` installs without Docker (embedded database).");
  } else {
    item(`${docker.gap.summary} — a real run would NOT install it.`);
    if (docker.gap.hint) item(docker.gap.hint);
  }

  head("Ports");
  item(
    `API ${plan.ports.api} · dashboard ${plan.ports.dashboard}` +
      (plan.ports.switched.api || plan.ports.switched.dashboard
        ? `  (preferred ${plan.ports.preferred.api}/${plan.ports.preferred.dashboard} — busy right now)`
        : ""),
  );
  if (plan.publicUrl) item(`public URL: ${plan.publicUrl}`);

  if (plan.compose) {
    head("Compose stack");
    // "secrets preserved" used to be printed for ANY existing `.env`, while whether a
    // given secret was actually preserved is a per-key question — so a re-run that was
    // about to regenerate the database password announced the opposite (#488). Both lines
    // now come from newSecrets, which is derived from the values that would be written.
    const { existing, newSecrets, secretRotation, pgDataRisk } = plan.compose;
    item(
      !existing
        ? "fresh install"
        : newSecrets.length === 0
          ? "re-runs an existing install (secrets preserved)"
          : chalk.yellow(
              `re-runs an existing install, but its .env no longer holds ${newSecrets.join(", ")} —` +
                ` a real run would GENERATE ${newSecrets.length > 1 ? "those" : "that"}, not preserve` +
                ` ${newSecrets.length > 1 ? "them" : "it"}.`,
            ),
    );
    for (const { key, value } of plan.compose.settings) item(`${key}=${value}`);
    // A real run refuses here, so the preview must not read as "this is what it would
    // write" — it would write nothing.
    if (secretRotation) {
      L.push(chalk.yellow(renderSecretRotationRefusal(secretRotation, { dryRun: true })));
    }
    // #487: same for a data volume whose cluster we can't place — a real run refuses
    // rather than write a guessed OPENSHIP_PGDATA, so say so instead of implying a write.
    if (pgDataRisk) {
      L.push(chalk.yellow(renderPgDataRefusal(pgDataRisk, { dryRun: true })));
    }
  }

  if (plan.edge) {
    head("Ports 80/443");
    if (!plan.edge.blocked) {
      // `blocked` is false exactly when nothing FOREIGN holds them, so this covers
      // both "free" and "already Openship's edge" — neither needs a decision.
      item("free (or already Openship's edge) — the edge container binds them.");
    } else {
      item(chalk.yellow(`held by ${plan.edge.owner}.`));
      item(
        plan.edge.sites.length
          ? `A real run would ask before touching it: migrate its ${plan.edge.sites.length} site(s) into Openship's edge, take over (its sites stop serving), or cancel.`
          : "A real run would ask before stopping it (--edge=migrate|takeover|cancel).",
      );
      for (const site of plan.edge.sites.slice(0, 8)) {
        item(`  • ${site.serverNames.join(", ") || "(no server_name)"}${site.ssl ? " [TLS]" : ""}`);
      }
      if (plan.edge.sites.length > 8) item(`  • …and ${plan.edge.sites.length - 8} more`);
    }
  }

  head("Would write");
  for (const w of plan.writes) item(w);

  if (plan.runs.length) {
    head("Would run");
    for (const r of plan.runs) item(r);
  }

  if (plan.service) {
    head(`${plan.service.kind} definition (${plan.service.path})`);
    L.push(plan.service.content.replace(/\n$/, ""));
  }
  if (plan.compose) {
    head(`docker-compose.yml (${plan.compose.composeFile})`);
    L.push(plan.compose.yaml.replace(/\n$/, ""));
  }

  L.push("", chalk.dim("  Re-run without --dry-run to apply this."), "");
  return L.join("\n");
}



function methodLabel(plan: UpPlan): string {
  if (plan.mode === "from-source") return "Build from source and run attached";
  if (plan.mode === "foreground") return "Run attached in this terminal";
  return plan.method === "compose"
    ? "Install the Docker Compose stack"
    : `Install the ${serviceWord(plan.service?.kind)} service`;
}

function serviceWord(kind?: ServiceKind): string {
  switch (kind) {
    case "launchd":
      return "launchd";
    case "systemd-user":
      return "systemd (--user)";
    case "systemd-system":
      return "systemd (system)";
    case "schtasks":
      return "Scheduled Task";
    default:
      return "process";
  }
}
