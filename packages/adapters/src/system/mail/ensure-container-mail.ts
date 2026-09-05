/**
 * Bring up the mail ENGINE as a container on a box, beside `openship-edge`.
 *
 * Mirrors `ensureContainerEdge` (host-networked container, raw `docker run` over
 * the target executor, all mutable state on host bind mounts) but for the mail
 * stack: an `openship-mail` engine image (Postfix/Dovecot/Amavis/…/supervisord)
 * plus a pinned `postgres:16-alpine` SIDECAR holding the vmail DB.
 *
 * Boundary that will NOT change: SMTP/IMAP are L4 protocols the HTTP edge cannot
 * proxy, so the engine binds the mail ports directly on the host NIC
 * (`--network host`) — the edge stays the HTTP/ACME/webmail front. `--cap-add
 * NET_ADMIN` lets the container's fail2ban touch the host firewall.
 *
 * Ordering follows the edge's rule: pull before anything stops, and an image swap
 * rolls back to the previous image if the new one doesn't come up — a failed
 * update must never leave the box without a mail engine.
 */

import { buildMailImageRef, safeErrorMessage, mailHostname } from "@repo/core";
import type { CommandExecutor, LogEntry } from "../../types";
import type { SystemLog, SystemLogCallback } from "../types";
import { sq } from "../local-shell";
import {
  containerImageRef,
  containerState,
  dockerAvailable,
  fromSourceImageMissingMessage,
  imageExistsLocally,
  managedImagesAreFromSource,
  swapManagedImage,
} from "../managed-image";
import { dirOf, elevatedExecutor } from "../elevated-executor";
import { resolveEnvironment } from "../environment";
import { waitForPortListening, probePortListeningOnce } from "../port-listen";
import { rootOrDegrade } from "../privilege";
import {
  MAIL_CONTAINER,
  MAIL_DB_CONTAINER,
  MAIL_CONTAINER_MOUNTS,
  MAIL_HOST_STATE_DIR,
  MAIL_DB_HOST_DATA_DIR,
  MAIL_DB_CONTAINER_DATA_DIR,
  MAIL_DB_PGDATA,
  MAIL_DB_NAME,
  MAIL_DB_USER,
  MAIL_DB_HOST_BIND,
  MAIL_DB_PORT,
  MAIL_DB_DEFAULT_PORT,
  MAIL_DB_FALLBACK_PORT,
  MAIL_DB_PORT_RANGE_MAX,
  MAIL_DB_INTERNAL_PORT,
  resolveMailDbPort,
  type MailMount,
} from "../../infra/mail-container";

function log(message: string, level: SystemLog["level"] = "info"): SystemLog {
  return { timestamp: new Date().toISOString(), message, level };
}

// The image to use when a call site passes none. The API injects its APP_VERSION-
// pinned ref once at boot (setDefaultMailImage) — this package can't compute it.
// Same rationale as setDefaultEdgeImage: a silent `:latest` fallback let call
// paths forget to pin.
let injectedDefaultImage: string | undefined;

/** Inject the API-resolved pinned mail image. Call once at app boot. */
export function setDefaultMailImage(image: string | undefined): void {
  injectedDefaultImage = image?.trim() || undefined;
}

/** The engine image to run — API-side consumer of the shared @repo/core precedence. */
export function resolveMailImage(explicit?: string): string {
  return buildMailImageRef({ explicit, injectedDefault: injectedDefaultImage });
}

/** Postgres sidecar image; overridable but pinned by default so pg-major is stable. */
export const MAIL_DB_IMAGE = process.env.OPENSHIP_MAIL_DB_IMAGE?.trim() || "postgres:16-alpine";

export interface ContainerMailResult {
  container: string;
  dbContainer: string;
  image: string;
  /** True when this call replaced a running engine with a different image. */
  updated?: boolean;
  /**
   * An image swap failed AND its rollback failed — this box has NO engine serving.
   * Distinct from `updated:false` (which also means "already on the right image").
   */
  mailDown?: boolean;
}

export interface ContainerMailOptions {
  onLog: SystemLogCallback;
  /** The primary mail domain (FIRST_DOMAIN), injected into the engine on first boot. */
  domain: string;
  /**
   * Per-install secrets (iRedMail DB passwords, etc.). Written to a 0600
   * env-file and passed via `--env-file`, never on the command line — so they
   * never appear in `ps`/shell history (the same no-shell-exposure rule the SASL
   * password write follows).
   */
  secrets: Record<string, string>;
  /** Explicit engine image ref; see {@link resolveMailImage}. */
  image?: string;
  container?: string;
  dbContainer?: string;
  /**
   * Host port for the PostgreSQL sidecar. Defaults to `OPENSHIP_MAIL_DB_PORT`
   * if set in the environment, otherwise 5432.
   */
  dbPort?: number;
  /** How long to wait for the mail ports before calling the start a failure. */
  verifyTimeoutMs?: number;
}

/** Is a container present (running or stopped)? */
async function containerExists(
  executor: CommandExecutor,
  container: string,
): Promise<boolean> {
  return (await containerState(executor, container)) !== null;
}

/**
 * Turn a failed `docker pull` into an actionable sentence.
 *
 * Three distinct causes, three different next steps:
 *   - the tag isn't in the registry (the mail engine image is not published yet,
 *     so this is the DEFAULT outcome on a box with no source checkout),
 *   - the registry refused us (private/needs a login),
 *   - the box couldn't reach the registry at all.
 * Anything unrecognised keeps docker's last line verbatim rather than guessing.
 */
function pullFailureMessage(image: string, output: string): string {
  const text = output.toLowerCase();
  const lastLine =
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";

  if (/manifest unknown|manifest for .* not found|not found: manifest|repository .* not found/.test(text)) {
    return (
      `The mail engine image ${image} isn't in the registry. ` +
      "The engine image isn't published yet, so a server can only run it from a local " +
      "build — build it on this box (or point OPENSHIP_MAIL_IMAGE at your own registry) and retry."
    );
  }
  if (/unauthorized|denied|authentication required|forbidden/.test(text)) {
    return (
      `The registry refused the mail engine image ${image} (${lastLine || "access denied"}). ` +
      "Log this server's Docker into that registry, or set OPENSHIP_MAIL_IMAGE to one it can read."
    );
  }
  if (/timeout|timed out|no such host|temporary failure|network is unreachable|connection refused|i\/o timeout|tls|certificate/.test(text)) {
    return (
      `This server couldn't reach the registry to pull ${image} (${lastLine || "network error"}). ` +
      "Check its outbound network/DNS and proxy settings, then retry."
    );
  }
  return `Could not pull the mail engine image ${image}${lastLine ? ` (${lastLine})` : ""}.`;
}

/** Render one bind mount as a `-v` arg. `:z` relabels for SELinux; ro when asked. */
function mountArg(m: MailMount): string {
  const opts = m.readonly ? "ro,z" : "z";
  return `-v ${sq(`${m.host}:${m.container}:${opts}`)}`;
}

/**
 * An env-file record is LINE-DELIMITED, so the line break — not the shell — is
 * the injection character here. A value containing CR/LF closes its own record
 * and everything after it becomes further `KEY=VALUE` records, which docker
 * feeds to the container verbatim.
 *
 * That matters because these values include an operator-supplied password, and
 * the engine runs `--network host --cap-add NET_ADMIN` with host bind mounts.
 * Two concrete escalations an injected record buys:
 *   - `BASH_FUNC_<name>%%=() { … }` — bash imports exported functions from the
 *     environment, so this SHADOWS a real binary the entrypoint calls (psql, nc,
 *     perl) and runs as root inside the container. Docker's own parser only
 *     rejects an empty key or whitespace IN the key, so `%%` sails through.
 *   - shadowing a legitimate key: duplicates are last-wins, and `...opts.secrets`
 *     is spread last, so an injected record overrides FIRST_DOMAIN /
 *     OPENSHIP_MAIL_DB_* (repoint the first-boot DB client, or reach the
 *     superuser SQL load that templates FIRST_DOMAIN in).
 *
 * So: validate the record shape and FAIL CLOSED. Rejecting beats sanitizing —
 * silently rewriting a password would produce an install whose stored credential
 * doesn't match the one the operator typed.
 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write the env-file the launcher passes via `--env-file`, mode 0600.
 *
 * Owned by whichever account this `executor` is — root when it is the elevated view, which
 * is why every caller follows the write with {@link handOverEnvFile}.
 */
async function writeEnvFile(
  executor: CommandExecutor,
  path: string,
  env: Record<string, string>,
): Promise<void> {
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) {
      throw new Error(`Refusing to write env-file: invalid variable name ${JSON.stringify(k)}.`);
    }
    if (/[\r\n]/.test(v)) {
      throw new Error(
        `Refusing to write env-file: value for ${k} spans multiple lines, which would inject additional environment records.`,
      );
    }
  }
  const body =
    Object.entries(env)
      // Values are single-line and unquoted — docker's env-file parser takes the
      // whole rest of the line verbatim as the value.
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  // Born private, not tightened after publication. The privileged executor's
  // private staging path carries this mode through its root-owned rename.
  await executor.writeFile(path, body, { mode: 0o600 });
}

const ENGINE_ENV_FILE = `${MAIL_HOST_STATE_DIR}/engine.env`;
const DB_ENV_FILE = `${MAIL_HOST_STATE_DIR}/db.env`;

/**
 * Hand a secret env-file to the account that runs `docker`, and make sure it can reach it.
 *
 * GH-630: `docker run --env-file <path>` opens that file CLIENT-SIDE, in the CLI's own
 * process, before it ever reaches the daemon socket — so it has to be readable by whoever
 * invokes docker, and being in the `docker` group grants the socket, not the file. The
 * elevated write publishes these root:root (`writeFile` chowns 0:0 so the `mv` cannot leave
 * the file writable by the login user) and `writeEnvFile` creates it as 0600, which on a non-root
 * login is exactly unreadable. Setting up mail died with `docker: --env-file: open
 * /var/lib/openship/mail/db.env: permission denied`, surfaced as the unrelated-sounding
 * "the mail database container failed to become ready".
 *
 * Moving the FILE rather than elevating the LAUNCH is the load-bearing choice. The docker
 * CLI's identity also decides which DAEMON it reaches and which registry credentials it
 * presents: `DOCKER_HOST` for a rootless daemon lives in the login user's shell profile,
 * which `sudo -n sh -c` never reads (the #482 trap), and root has its own
 * ~/.docker/config.json. A `docker run` elevated to root while every inspect and pull stays
 * on the login user can therefore address a different daemon entirely — creating a SECOND
 * host-network engine to fight the live one for :25, and passing verification anyway because
 * the /proc port probe is daemon-blind. So every docker command on the mail path runs as one
 * identity and only the file moves. (`installContainerEdge` does elevate its own docker, so
 * this is not a repo-wide invariant: that path passes no `--env-file` and its bind mounts are
 * resolved daemon-side by root, so it never needed the login user's view of the filesystem.)
 *
 * Three operations, and the two beyond the chown each close a way it silently fails anyway:
 *
 *  1. `chown` — the handover itself.
 *  2. `chmod 400`, not 600. The kernel enforces the mode against the owner too, so
 *     read-only keeps docker's client-side read working while an UNELEVATED `writeFile`
 *     still fails loudly — and that refusal is load-bearing. `retainedDbPassword`'s
 *     `test -s .../pgdata/PG_VERSION` probe reads "denied" as "no cluster" (pgdata is 0700
 *     uid-999), so if elevation later degrades, a re-run mints a fresh superuser password
 *     and would overwrite the only copy of the one the cluster was initialised with — GH-564
 *     with its recovery value destroyed. Before this handover existed that write was refused
 *     because the file was root's; 0400 keeps it refused now that it is the login user's.
 *  3. `chmod a+x` on the two directories above it. Ownership is not reach: docker opens the
 *     file as `loginUser`, so every component of the path must be traversable by it. The tree
 *     is created by a bare `mkdir -p` (step 2) that takes the sudo session's umask — 0755 on
 *     a default host, but 0750 wherever login.defs sets UMASK 027 (the CIS default), and
 *     there the chown succeeds while the open fails with the identical error and nothing
 *     warns. `a+x` grants search without listing, and only on the arm that needs it, so a
 *     root-only box stays exactly as tight as it is today. Deliberately NOT `ensureOwnedDir`,
 *     whose `chown -R` would hand the container's vmail and pgdata trees to the login user.
 *
 * Confidentiality is unchanged, and provably so from two directions: the account gaining
 * ownership already held the plaintext, because `elevatedExecutor.writeFile` stages the
 * content unelevated as that same login before publishing it; and it provably has arbitrary
 * root, because the chown only lands if `sudo -n sh -c` does. It is the account Openship
 * drives THIS SERVER as — a remote box's SSH login, not necessarily the one Openship itself
 * runs under.
 *
 * `canSudo` is the exact condition, and it is a property of the writer rather than a guess: a
 * root login already owns the file, and a login with no route to root wrote it itself
 * (`rootOrDegrade` degrades to the caller's own executor) — and on the swap arm, where this
 * run wrote nothing, has no route to root to repair it with either. A probe that cannot
 * answer lands there too, which is why it degrades instead of throwing: `ensureContainerMail`
 * documents that a best-effort image swap never throws, and this is the one await in it that
 * would otherwise break that contract.
 */
async function handOverEnvFile(
  executor: CommandExecutor,
  path: string,
  onLog: SystemLogCallback,
): Promise<void> {
  const profile = await resolveEnvironment(executor).catch(() => null);
  if (!profile || profile.isRoot || !profile.canSudo) return;

  // `$SUDO_USER` only as a last resort, so an owner we could not name fails loudly rather
  // than expanding to nothing — `ensureOwnedDir` keeps the same fallback for the same reason.
  // A uid with no passwd entry answers `opsh_uid`/`opsh_sudo` but leaves `opsh_user` empty,
  // and that is precisely a host whose file IS root-owned and does need the handover.
  const owner = profile.loginUser ? sq(profile.loginUser) : '"$SUDO_USER"';
  const stateDir = dirOf(path);

  // One `&&` chain: reach without ownership is as useless as ownership without reach, so a
  // failure at any step has to reach the operator rather than leave a half-done handover
  // reported as success.
  await elevatedExecutor(executor)
    .exec(
      `chown ${owner} ${sq(path)} && chmod 400 ${sq(path)} && ` +
        `chmod a+x ${sq(stateDir)} ${sq(dirOf(stateDir))}`,
    )
    .catch((err: unknown) => {
      onLog(
        log(
          `Could not give ${profile.loginUser || "the login user"} access to ${path}: ` +
            `${safeErrorMessage(err)}. docker opens --env-file as that account, so the mail ` +
            "containers will fail to start.",
          "warn",
        ),
      );
    });
}

/** One key back out of an env-file we wrote. Same trivial `K=V` shape as `writeEnvFile`. */
async function readEnvFileValue(
  executor: CommandExecutor,
  path: string,
  key: string,
): Promise<string | null> {
  let body = "";
  if (typeof (executor as unknown as { readFile?: (p: string) => Promise<string> }).readFile === "function") {
    body = await executor.readFile(path).catch(() => "");
  } else if (typeof executor.exec === "function") {
    const escaped = sq(path);
    const out = await executor.exec(`test -f ${escaped} && cat ${escaped} || true`).catch(() => "");
    body = typeof out === "string" ? out : "";
  }
  for (const line of body.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === key) {
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return null;
}

/**
 * The superuser password an ALREADY-INITIALISED cluster is holding, or null if this is a
 * first install.
 *
 * GH-564: `POSTGRES_PASSWORD` only takes effect during `initdb`. On a redeploy over a
 * RETAINED pgdata the sidecar starts a cluster that already has its own superuser
 * password, so handing it a freshly minted one means every connection fails auth —
 * db-bootstrap then cannot load the schema and `vmail` never appears. The engine's
 * early-return is keyed on the ENGINE container existing, so an engine that was removed
 * (or never came up) while pgdata survived lands straight in the create path.
 *
 * So: if the data directory holds a cluster, the credential of record is the one on disk,
 * not the one we just generated. PG_VERSION is the marker initdb writes — the same probe
 * the compose path uses.
 */
async function retainedDbPassword(
  executor: CommandExecutor,
  onLog: SystemLogCallback,
): Promise<string | null> {
  const initialised = await executor
    .exec(`test -s ${sq(`${MAIL_DB_HOST_DATA_DIR}/pgdata/PG_VERSION`)} && echo yes || true`)
    .then((out) => out.trim() === "yes")
    .catch(() => false);
  if (!initialised) return null;

  const retained = await readEnvFileValue(executor, DB_ENV_FILE, "POSTGRES_PASSWORD");
  if (retained) {
    onLog(
      log(
        `Reusing the existing mail database credential — ${MAIL_DB_HOST_DATA_DIR} already ` +
          `holds an initialised cluster, and its superuser password cannot be changed by ` +
          `an env var.`,
      ),
    );
    return retained;
  }

  // The cluster exists but we no longer hold its password. Minting one would produce a
  // sidecar that cannot authenticate, a failed bootstrap, and a confusing error far from
  // the cause — so stop here and name the two things that actually recover it.
  throw new Error(
    `The mail database directory ${MAIL_DB_HOST_DATA_DIR} holds an initialised Postgres ` +
      `cluster, but its credential is missing from ${DB_ENV_FILE}. A new password cannot ` +
      `be applied to an existing cluster. Either restore ${DB_ENV_FILE} with the original ` +
      `POSTGRES_PASSWORD, or — if the mail data is expendable — remove ` +
      `${MAIL_DB_HOST_DATA_DIR} to reinitialise the database from scratch.`,
  );
}

/**
 * For an existing initialised cluster, read the retained database port from ENGINE_ENV_FILE.
 * Preserving the previously assigned port prevents repairs/restarts from drifting ports.
 */
export async function retainedDbPort(
  executor: CommandExecutor,
  onLog?: SystemLogCallback,
): Promise<number | null> {
  const initialised = await executor
    .exec(`test -s ${sq(`${MAIL_DB_HOST_DATA_DIR}/pgdata/PG_VERSION`)} && echo yes || true`)
    .then((out) => out.trim() === "yes")
    .catch(() => false);
  if (!initialised) return null;

  const retained = await readEnvFileValue(executor, ENGINE_ENV_FILE, "OPENSHIP_MAIL_DB_PORT");
  if (!retained) return null;
  const n = Number(retained.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;

  onLog?.(
    log(
      `Reusing existing mail database port ${n} — ${MAIL_DB_HOST_DATA_DIR} already holds ` +
        `an initialised cluster.`,
    ),
  );
  return n;
}

/**
 * Resolve an available host loopback port for the mail database sidecar.
 * If the preferred port is free, returns it. If the default 5432 is occupied and
 * the port was not explicitly specified, scans up to MAIL_DB_PORT_RANGE_MAX (5460)
 * for the first available port.
 */
export async function findAvailableMailDbPort(
  executor: CommandExecutor,
  preferredPort: number,
  isExplicit: boolean,
  onLog: SystemLogCallback,
): Promise<number> {
  // Clear any stale dead sidecar container name so its port binding is freed before testing
  await executor.exec(`docker rm -f ${sq(MAIL_DB_CONTAINER)} 2>/dev/null || true`).catch(() => {});

  const probe = await probePortListeningOnce(executor, preferredPort);
  if (probe !== true) {
    return preferredPort;
  }

  // If the user explicitly configured this port, do not auto-switch ports
  if (isExplicit) {
    return preferredPort;
  }

  // Auto-discovery: default port is occupied; scan candidate range 5433..5460
  for (let port = MAIL_DB_FALLBACK_PORT; port <= MAIL_DB_PORT_RANGE_MAX; port++) {
    const candidate = await probePortListeningOnce(executor, port);
    if (candidate !== true) {
      onLog(
        log(
          `Default PostgreSQL port ${preferredPort} is in use on this host. ` +
            `Automatically selected available port ${port} for the mail database ` +
            `(can be overridden via OPENSHIP_MAIL_DB_PORT).`,
          "warn",
        ),
      );
      return port;
    }
  }

  return preferredPort;
}

/** `docker run` argv for the Postgres sidecar (loopback-published, bind-mounted data). */
export function buildDbRunCommand(
  container: string,
  dbPort: number = resolveMailDbPort(),
): string {
  return [
    "docker run -d",
    `--name ${sq(container)}`,
    "--restart unless-stopped",
    `--env-file ${sq(DB_ENV_FILE)}`,
    `-e ${sq(`PGDATA=${MAIL_DB_PGDATA}`)}`,
    `-p ${sq(`${MAIL_DB_HOST_BIND}:${dbPort}:${MAIL_DB_INTERNAL_PORT}`)}`,
    `-v ${sq(`${MAIL_DB_HOST_DATA_DIR}:${MAIL_DB_CONTAINER_DATA_DIR}:z`)}`,
    sq(MAIL_DB_IMAGE),
  ].join(" ");
}

/**
 * `docker run` argv for the engine: host networking + NET_ADMIN + the mounts.
 * `--hostname` sets the container's gethostname() to `mail.<domain>` so the mail
 * daemons' defaults line up with PTR/HELO without ever mutating the HOST hostname
 * (host-native provisioning used to set the box hostname; the container owns it).
 */
export function buildMailRunCommand(container: string, image: string, hostname?: string): string {
  const mounts = MAIL_CONTAINER_MOUNTS.map(mountArg).join(" ");
  return [
    "docker run -d",
    `--name ${sq(container)}`,
    "--network host",
    hostname ? `--hostname ${sq(hostname)}` : "",
    "--restart unless-stopped",
    "--cap-add NET_ADMIN",
    `--env-file ${sq(ENGINE_ENV_FILE)}`,
    mounts,
    sq(image),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Start (or restart) the Postgres sidecar. `docker rm -f` first frees a stale name. */
async function startDb(
  executor: CommandExecutor,
  container: string,
  onLog: SystemLogCallback,
  dbPort: number = resolveMailDbPort(),
): Promise<boolean> {
  await executor.exec(`docker rm -f ${sq(container)} 2>/dev/null || true`).catch(() => {});
  const run = await executor.streamExec(buildDbRunCommand(container, dbPort), onLog as (l: LogEntry) => void);
  if (run.code !== 0) return false;
  const listening = await waitForPortListening(executor, dbPort, { timeoutMs: 60_000 });
  // checked:false = inconclusive probe; don't fail the DB on a missing /proc read.
  return !(listening.checked && !listening.listening);
}

/** Start (or restart) the engine container. */
async function startEngine(
  executor: CommandExecutor,
  container: string,
  image: string,
  hostname: string,
  onLog: SystemLogCallback,
): Promise<boolean> {
  await executor.exec(`docker rm -f ${sq(container)} 2>/dev/null || true`).catch(() => {});
  const run = await executor.streamExec(
    buildMailRunCommand(container, image, hostname),
    onLog as (l: LogEntry) => void,
  );
  return run.code === 0;
}

/**
 * Prove the engine is actually serving: SMTP (:25) and IMAPS (:993) listening.
 * First boot runs schema init + config seed, so allow a generous window.
 */
/**
 * "Is a mail engine actually serving?" — :25 then :993.
 *
 * Deliberately flavor-blind, and exported for that reason: the container runs
 * `--network host`, so a legacy host-native install and the engine container are
 * indistinguishable from the host NIC's point of view. `startHostMail` verifies
 * through this same function (see detect-engine.ts) so both repairs hold
 * themselves to one definition of "up".
 */
export async function verifyMailEngine(
  executor: CommandExecutor,
  opts: { verifyTimeoutMs?: number },
): Promise<{ ok: boolean; reason?: string }> {
  const timeoutMs = opts.verifyTimeoutMs ?? 180_000;
  const smtp = await waitForPortListening(executor, 25, { timeoutMs });
  if (smtp.checked && !smtp.listening) {
    return { ok: false, reason: "the engine started but nothing is listening on :25 (SMTP)" };
  }
  const imaps = await waitForPortListening(executor, 993, { timeoutMs: 30_000 });
  if (imaps.checked && !imaps.listening) {
    return { ok: false, reason: "the engine started but nothing is listening on :993 (IMAPS)" };
  }
  return { ok: true };
}

/**
 * The engine's "start this image AND prove it's actually serving" callback — the
 * unit `swapManagedImage` drives. Recreating the engine is safe: the sidecar and all
 * data live on bind mounts, so a swap that fails verification rolls back to the old
 * image with nothing lost. Mirrors the edge's `makeEdgeStart`.
 */
function makeMailStart(
  executor: CommandExecutor,
  container: string,
  opts: ContainerMailOptions,
): (image: string) => Promise<boolean> {
  const { onLog } = opts;
  const hostname = mailHostname(opts.domain);
  return async (image: string) => {
    if (!(await startEngine(executor, container, image, hostname, onLog))) return false;
    return (await verifyMailEngine(executor, opts)).ok;
  };
}

/**
 * Idempotent: returns early when our engine is already running on the pinned image
 * (and swaps it in place when it isn't). Otherwise creates host dirs, writes the
 * secret env-files, launches the DB sidecar then the engine, and verifies.
 *
 * Throws on a first-time bring-up failure after dumping the container logs; a
 * best-effort image swap never throws (it reports `mailDown`).
 */
export async function ensureContainerMail(
  executor: CommandExecutor,
  opts: ContainerMailOptions,
): Promise<ContainerMailResult> {
  const { onLog } = opts;
  const container = opts.container?.trim() || MAIL_CONTAINER;
  const dbContainer = opts.dbContainer?.trim() || MAIL_DB_CONTAINER;
  const image = resolveMailImage(opts.image);

  // Container already there (running or stopped)? Reconcile only the IMAGE — data +
  // DB persist on the binds. Deliberately keyed on EXISTENCE, not run state: falling
  // into the create path for a stopped engine would rewrite its secret env files.
  // Staleness is a plain tag-compare: the dev tag is content-derived (`…-dev.<hash>`),
  // so a source edit moves it exactly like a prod version bump. `swapManagedImage`
  // pulls only if the target tag isn't already on the box (deliver shipped the dev
  // image there first), so the dev flow needs no build-on-executor branch.
  const current = await containerImageRef(executor, container);
  if (current) {
    if (current === image) return { container, dbContainer, image, updated: false };

    // The `engine.env` this swap launches against was written by a PREVIOUS install, so on
    // a box provisioned before GH-630 it is still root-owned and no amount of relaunching
    // fixes it. Repair it here, or a non-root box can never update its engine: `startEngine`
    // dies on the client-side `--env-file` open, `swapManagedImage` rolls back through the
    // same callback and dies identically, and a perfectly healthy engine gets reported as
    // `mailDown` with nothing in the log pointing at permissions.
    await handOverEnvFile(executor, ENGINE_ENV_FILE, onLog);

    const start = makeMailStart(executor, container, opts);
    const swap = await swapManagedImage(executor, {
      kind: "mail",
      from: current,
      to: image,
      label: "mail engine",
      onLog,
      start,
    });
    return { container, dbContainer, image, updated: swap.swapped, mailDown: swap.down };
  }

  if (!(await dockerAvailable(executor))) {
    throw new Error(
      "Docker isn't available on this server, and the mail engine now runs as a container. " +
        "Install the Docker component first, then set up mail.",
    );
  }

  // 1. Obtain the image before anything is created. Pull unless it's already on the
  //    box: in dev the control plane built the `…-dev.<hash>` engine from our source
  //    and shipped it here (deliverManagedImage), so the unpublished tag is present
  //    and a pull would 404; in prod the tag is absent → pull `:APP_VERSION`.
  if (!(await imageExistsLocally(executor, image))) {
    if (managedImagesAreFromSource("mail")) {
      // Unpublished from-source (dev) engine tag the control plane was meant to build
      // and ship here (deliverManagedImage). It's absent, so that didn't finish — a
      // pull can only 404. Surface the real cause rather than a registry error.
      throw new Error(fromSourceImageMissingMessage("mail engine", image));
    }
    onLog(log(`Pulling mail engine image ${image}...`));
    // Keep the pull's own words: "the tag doesn't exist" and "the registry is
    // unreachable" are opposite problems with opposite fixes, and a single
    // "check your network" message sent operators chasing a firewall when the
    // real answer was that this tag was never published.
    const output: string[] = [];
    const pull = await executor.streamExec(`docker pull ${sq(image)}`, (l: LogEntry) => {
      output.push(l.message);
      (onLog as (l: LogEntry) => void)(l);
    });
    if (pull.code !== 0) throw new Error(pullFailureMessage(image, output.join("\n")));
  }

  // 2. Host state dirs (engine mounts + DB data dir). Through the privilege gate, and
  //    reported rather than swallowed: these are root-owned paths under
  //    /var/lib/openship/mail, so on a box we log into as a non-root sudo user the
  //    unelevated `mkdir` fails. The comment here already named the consequence — "a
  //    missing host dir silently becomes an empty bind and loses data" — and then
  //    `.catch(() => {})` made it silent, so the one outcome worth an operator's
  //    attention was the one nothing could observe. Degrades rather than throws, so an
  //    unmeasurable host keeps today's behaviour.
  const hostState = await rootOrDegrade(executor, {
    purpose: "Creating the mail engine's host state directories",
    consequence: "A missing directory becomes an empty bind mount, which loses mail data.",
    report: (message) => onLog(log(message, "warn")),
  });
  for (const mount of MAIL_CONTAINER_MOUNTS) {
    await hostState.exec(`mkdir -p ${sq(mount.host)}`).catch((err: unknown) => {
      onLog(
        log(
          `Could not create the mail state directory ${mount.host}: ${safeErrorMessage(err)}. ` +
            `Docker will create it empty, which loses mail data.`,
          "warn",
        ),
      );
    });
  }
  await hostState.exec(`mkdir -p ${sq(MAIL_DB_HOST_DATA_DIR)}`).catch((err: unknown) => {
    onLog(
      log(
        `Could not create the mail database directory ${MAIL_DB_HOST_DATA_DIR}: ` +
          `${safeErrorMessage(err)}. Postgres will start on an empty bind mount.`,
        "warn",
      ),
    );
  });

  // 3. Secret env-files (root-only), consumed via --env-file so creds never hit a
  //    shell string. The engine's first-boot entrypoint reads these to init the
  //    vmail DB against the sidecar and template FIRST_DOMAIN in.
  // The sidecar boots as the `postgres` superuser (password = iRedMail's
  // PGSQL_ROOT_PASSWD) with an empty `vmail` database; the engine's first-boot
  // entrypoint then creates the vmail/vmailadmin/amavisd/iredapd/fail2ban roles
  // (from the per-role passwords passed in the engine env) and loads the schema.
  // A cluster already on disk owns its own superuser password (GH-564); a freshly
  // generated one would only be applied by initdb, which will not run again.
  const retainedRoot = await retainedDbPassword(hostState, onLog);
  const dbRootPassword =
    retainedRoot ?? opts.secrets.PGSQL_ROOT_PASSWD ?? opts.secrets.VMAIL_DB_ADMIN_PASSWD ?? "";
  const isExplicitPort =
    opts.dbPort !== undefined || Boolean(process.env.OPENSHIP_MAIL_DB_PORT?.trim());
  const preferredPort = resolveMailDbPort(opts.dbPort);
  const retainedPort = await retainedDbPort(hostState, onLog);
  const dbPort =
    retainedPort ?? (await findAvailableMailDbPort(executor, preferredPort, isExplicitPort, onLog));
  await writeEnvFile(hostState, DB_ENV_FILE, {
    POSTGRES_USER: "postgres",
    POSTGRES_DB: MAIL_DB_NAME,
    POSTGRES_PASSWORD: dbRootPassword,
  });
  await handOverEnvFile(executor, DB_ENV_FILE, onLog);
  await writeEnvFile(hostState, ENGINE_ENV_FILE, {
    FIRST_DOMAIN: opts.domain,
    OPENSHIP_MAIL_DB_HOST: MAIL_DB_HOST_BIND,
    OPENSHIP_MAIL_DB_PORT: String(dbPort),
    OPENSHIP_MAIL_DB_NAME: MAIL_DB_NAME,
    OPENSHIP_MAIL_DB_USER: MAIL_DB_USER,
    ...opts.secrets,
    // Spread LAST so the retained value wins: the engine's first-boot bootstrap connects
    // as the superuser, and it has to use the password the cluster actually has, not the
    // one this deploy generated.
    ...(retainedRoot ? { PGSQL_ROOT_PASSWD: retainedRoot } : {}),
  });
  await handOverEnvFile(executor, ENGINE_ENV_FILE, onLog);

  try {
    // 4. DB sidecar first — the engine's entrypoint blocks on it.
    onLog(log("Starting the mail database (postgres sidecar)..."));
    if (!(await startDb(executor, dbContainer, onLog, dbPort))) {
      throw new Error("the mail database container failed to become ready");
    }

    // 5. Engine.
    onLog(log("Starting the mail engine container..."));
    if (!(await startEngine(executor, container, image, mailHostname(opts.domain), onLog))) {
      throw new Error("the mail engine container failed to start");
    }

    // 6. Prove it's actually serving mail.
    const verified = await verifyMailEngine(executor, opts);
    if (!verified.ok) throw new Error(verified.reason ?? "the mail engine did not come up");

    onLog(log("Mail engine container running"));
    return { container, dbContainer, image };
  } catch (err) {
    const msg = safeErrorMessage(err);
    onLog(log(`Mail engine setup failed: ${msg}`, "error"));
    const logs = await executor
      .exec(`docker logs --tail 60 ${sq(container)} 2>&1 || true`)
      .catch(() => "");
    if (logs.trim()) onLog(log(`Mail engine logs:\n${logs}`, "error"));
    throw new Error(`Mail engine setup failed: ${msg}`);
  }
}

/**
 * Start an EXISTING but stopped mail stack back up — the repair sibling of
 * {@link ensureContainerMail}, for a box whose engine was stopped (a reboot without
 * `--restart` honouring it, an operator `docker stop`, an OOM kill).
 *
 * `docker start` only: no `docker rm`, no `docker run`, no env-file write. That's
 * the whole point — `ensureContainerMail`'s first-boot path re-templates the secret
 * env-files from `opts.secrets`, which are provisioned once by the mail wizard and
 * are NOT re-derivable, so calling it to "fix" a stopped engine would destroy a live
 * mailbox. Starting the existing containers keeps every secret and every byte of
 * data exactly where it is.
 *
 * Deliberately does NOT recreate a MISSING container (either one): that needs the
 * secrets + domain this call doesn't have, so it reports the state instead and
 * leaves it to the mail-setup path.
 */
export async function startContainerMail(
  executor: CommandExecutor,
  opts: {
    onLog: SystemLogCallback;
    container?: string;
    dbContainer?: string;
    dbPort?: number;
    verifyTimeoutMs?: number;
  },
): Promise<{ started: boolean; reason?: string }> {
  const { onLog } = opts;
  const container = opts.container?.trim() || MAIL_CONTAINER;
  const dbContainer = opts.dbContainer?.trim() || MAIL_DB_CONTAINER;
  const retainedPort = await retainedDbPort(executor, onLog);
  const dbPort = retainedPort ?? resolveMailDbPort(opts.dbPort);

  const engineState = await containerState(executor, container);
  if (!engineState) {
    return {
      started: false,
      reason: "the mail engine container doesn't exist on this server — re-run mail setup",
    };
  }
  if (engineState.running) {
    return { started: false, reason: "the mail engine is already running" };
  }
  if (!(await containerExists(executor, dbContainer))) {
    return {
      started: false,
      reason: "the mail database container doesn't exist on this server — re-run mail setup",
    };
  }

  // DB sidecar first: the engine's entrypoint blocks on it.
  onLog(log("Starting the mail database (postgres sidecar)..."));
  const db = await executor.streamExec(
    `docker start ${sq(dbContainer)}`,
    onLog as (l: LogEntry) => void,
  );
  if (db.code !== 0) {
    return { started: false, reason: "the mail database container did not start" };
  }
  const dbListening = await waitForPortListening(executor, dbPort, { timeoutMs: 60_000 });
  // checked:false = inconclusive probe; don't fail on a missing /proc read.
  if (dbListening.checked && !dbListening.listening) {
    return { started: false, reason: `the mail database is not listening on :${dbPort}` };
  }

  onLog(log("Starting the mail engine container..."));
  const engine = await executor.streamExec(
    `docker start ${sq(container)}`,
    onLog as (l: LogEntry) => void,
  );
  const verified = engine.code === 0 ? await verifyMailEngine(executor, opts) : { ok: false };
  if (!verified.ok) {
    const reason =
      ("reason" in verified ? verified.reason : undefined) ??
      "the mail engine container did not start";
    onLog(log(`Could not start the mail engine: ${reason}`, "error"));
    const logs = await executor
      .exec(`docker logs --tail 60 ${sq(container)} 2>&1 || true`)
      .catch(() => "");
    if (logs.trim()) onLog(log(`Mail engine logs:\n${logs}`, "error"));
    return { started: false, reason };
  }

  onLog(log("Mail engine running again"));
  return { started: true };
}

/**
 * The engine container's existence, run state and image ref — one `docker inspect`.
 *
 * `running` is read from `.State.Running`, so a provisioned-but-stopped engine
 * reads `{ exists: true, running: false }` and the caller can offer the start-only
 * repair. `image` is the created-with ref either way, which is what drift compares
 * against the pinned ref (a stopped engine on an old tag is still behind).
 */
export async function detectMailContainer(
  executor: CommandExecutor,
  container = MAIL_CONTAINER,
): Promise<{ running: boolean; image: string | null; exists: boolean }> {
  const state = await containerState(executor, container);
  if (!state) return { running: false, image: null, exists: false };
  return { running: state.running, image: state.image, exists: true };
}
