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

import { buildMailImageRef, safeErrorMessage } from "@repo/core";
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
import { waitForPortListening } from "../port-listen";
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
   * Per-install secrets (iRedMail DB passwords, etc.). Written to a root-only
   * env-file and passed via `--env-file`, never on the command line — so they
   * never appear in `ps`/shell history (the same no-shell-exposure rule the SASL
   * password write follows).
   */
  secrets: Record<string, string>;
  /** Explicit engine image ref; see {@link resolveMailImage}. */
  image?: string;
  container?: string;
  dbContainer?: string;
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

/** Write a root-only env-file the launcher passes via `--env-file`. */
async function writeEnvFile(
  executor: CommandExecutor,
  path: string,
  env: Record<string, string>,
): Promise<void> {
  const body =
    Object.entries(env)
      // Values may contain anything; keep them one-per-line and unquoted — docker's
      // env-file parser takes the whole rest of the line verbatim as the value.
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  await executor.writeFile(path, body);
  await executor.exec(`chmod 600 ${sq(path)}`).catch(() => {});
}

const ENGINE_ENV_FILE = `${MAIL_HOST_STATE_DIR}/engine.env`;
const DB_ENV_FILE = `${MAIL_HOST_STATE_DIR}/db.env`;

/** `docker run` argv for the Postgres sidecar (loopback-published, bind-mounted data). */
function buildDbRunCommand(container: string): string {
  return [
    "docker run -d",
    `--name ${sq(container)}`,
    "--restart unless-stopped",
    `--env-file ${sq(DB_ENV_FILE)}`,
    `-e ${sq(`PGDATA=${MAIL_DB_PGDATA}`)}`,
    `-p ${sq(`${MAIL_DB_HOST_BIND}:${MAIL_DB_PORT}:${MAIL_DB_PORT}`)}`,
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
): Promise<boolean> {
  await executor.exec(`docker rm -f ${sq(container)} 2>/dev/null || true`).catch(() => {});
  const run = await executor.streamExec(buildDbRunCommand(container), onLog as (l: LogEntry) => void);
  if (run.code !== 0) return false;
  const listening = await waitForPortListening(executor, MAIL_DB_PORT, { timeoutMs: 60_000 });
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
  const hostname = `mail.${opts.domain}`;
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

  // 2. Host state dirs (engine mounts + DB data dir), created over the same
  //    executor that runs the containers — a missing host dir silently becomes an
  //    empty bind and loses data.
  for (const mount of MAIL_CONTAINER_MOUNTS) {
    await executor.exec(`mkdir -p ${sq(mount.host)}`).catch(() => {});
  }
  await executor.exec(`mkdir -p ${sq(MAIL_DB_HOST_DATA_DIR)}`).catch(() => {});

  // 3. Secret env-files (root-only), consumed via --env-file so creds never hit a
  //    shell string. The engine's first-boot entrypoint reads these to init the
  //    vmail DB against the sidecar and template FIRST_DOMAIN in.
  // The sidecar boots as the `postgres` superuser (password = iRedMail's
  // PGSQL_ROOT_PASSWD) with an empty `vmail` database; the engine's first-boot
  // entrypoint then creates the vmail/vmailadmin/amavisd/iredapd/fail2ban roles
  // (from the per-role passwords passed in the engine env) and loads the schema.
  await writeEnvFile(executor, DB_ENV_FILE, {
    POSTGRES_USER: "postgres",
    POSTGRES_DB: MAIL_DB_NAME,
    POSTGRES_PASSWORD:
      opts.secrets.PGSQL_ROOT_PASSWD ?? opts.secrets.VMAIL_DB_ADMIN_PASSWD ?? "",
  });
  await writeEnvFile(executor, ENGINE_ENV_FILE, {
    FIRST_DOMAIN: opts.domain,
    OPENSHIP_MAIL_DB_HOST: MAIL_DB_HOST_BIND,
    OPENSHIP_MAIL_DB_PORT: String(MAIL_DB_PORT),
    OPENSHIP_MAIL_DB_NAME: MAIL_DB_NAME,
    OPENSHIP_MAIL_DB_USER: MAIL_DB_USER,
    ...opts.secrets,
  });

  try {
    // 4. DB sidecar first — the engine's entrypoint blocks on it.
    onLog(log("Starting the mail database (postgres sidecar)..."));
    if (!(await startDb(executor, dbContainer, onLog))) {
      throw new Error("the mail database container failed to become ready");
    }

    // 5. Engine.
    onLog(log("Starting the mail engine container..."));
    if (!(await startEngine(executor, container, image, `mail.${opts.domain}`, onLog))) {
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
    verifyTimeoutMs?: number;
  },
): Promise<{ started: boolean; reason?: string }> {
  const { onLog } = opts;
  const container = opts.container?.trim() || MAIL_CONTAINER;
  const dbContainer = opts.dbContainer?.trim() || MAIL_DB_CONTAINER;

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
  const dbListening = await waitForPortListening(executor, MAIL_DB_PORT, { timeoutMs: 60_000 });
  // checked:false = inconclusive probe; don't fail on a missing /proc read.
  if (dbListening.checked && !dbListening.listening) {
    return { started: false, reason: `the mail database is not listening on :${MAIL_DB_PORT}` };
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
