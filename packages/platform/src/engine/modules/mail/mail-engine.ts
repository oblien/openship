/**
 * The mail engine's topology matrix — and the ONLY place that knows it.
 *
 * A box runs mail in one of two shapes (see `detectMailEngine`): the supported
 * `container` engine + pg sidecar, or a LEGACY `host` install (systemd
 * Postfix/Dovecot, vmail in the host PostgreSQL). Same data, same daemons, same
 * DB name — different transport for every command that touches them:
 *
 * | concern      | container                                    | host                        |
 * |--------------|----------------------------------------------|-----------------------------|
 * | vmail SQL    | `docker exec openship-mail-db psql -U postgres` | `sudo -u postgres psql`  |
 * | daemon state | `supervisorctl status` in the engine          | `systemctl show`            |
 * | daemon action| `supervisorctl <action>` / `docker <action>`   | `systemctl --no-block`      |
 * | daemon logs  | supervisord's per-program log / `docker logs`  | `journalctl -u`             |
 * | postfix cmds | `docker exec openship-mail <cmd>`             | the command, on the host     |
 * | config files | host bind mount ↔ in-engine path              | one path, both sides         |
 *
 * Containerization replaced the host column wholesale instead of branching, which
 * is why a legacy box currently 500s in the admin panel ("No such container:
 * openship-mail-db") and shows up as a dead "Mail engine is down" in the fleet
 * view while it is quietly delivering mail. The image is not published yet, so
 * legacy is not a tail case — it is every mail box provisioned so far.
 *
 * The rule this file exists to enforce: **no other module branches on topology.**
 * Services ask for a command string and stay flavor-blind. When host-native
 * retires, `detectMailEngine` stops returning `"host"`, the `host` column here
 * becomes dead code in ONE file, and nothing else changes.
 *
 * Resolution is memoized per executor (WeakMap), so a request that runs 9 daemon
 * probes over one SSH connection probes the topology once, and the memo dies with
 * the connection (ssh-manager drops idle executors after 5 min) — there is no TTL
 * to tune and no cache to invalidate by hand. A command that fails with a
 * "wrong flavor" signature drops the memo and re-probes to report the accurate
 * reason, so a hand-migrated box self-corrects on its next call.
 *
 * Only a POSITIVE topology (an engine exists) is retained. A `flavor: "none"` is
 * NOT memoized: that executor is pooled per server, so a `getStatus` poll probing
 * a box mid-setup would otherwise pin "no engine" for the whole run — and the DKIM
 * step one line after "Mail engine container running" would trust it and refuse.
 * A "nothing here" is exactly the state `deploy_engine` ends, so it's re-probed
 * every call, same as a transient failure.
 */

import { randomBytes } from "node:crypto";
import { dirname } from "node:path/posix";

import {
  detectMailEngine,
  MAIL_CONTAINER,
  MAIL_DB_CONTAINER,
  MAIL_DB_NAME,
  MAIL_HOST_PATHS,
  privilegedExecutor,
  type CommandExecutor,
  type MailEngineFlavor,
  type MailEngineProbe,
} from "@repo/adapters";
import { AppError } from "@repo/core";

import { sshManager } from "../../lib/ssh-manager";

export type { MailEngineFlavor, MailEngineProbe };

/** Either a server id (we acquire the executor) or an executor already in hand. */
export type MailTarget = string | CommandExecutor;

/**
 * Why a mail operation can't run — with the remediation baked into the reason, so
 * every surface offers the same next step:
 *   - `not_installed` → there is no mail engine on this box (re-run mail setup),
 *   - `not_running`   → there is one, it just isn't up (the one-click repair).
 *
 * An `AppError` so the existing `handleApiError` / `errorJson` funnels turn it
 * into a 409 with a code the dashboard can branch on, instead of the bare 500 a
 * raw "No such container" produced.
 */
export type MailEngineUnavailableReason = "not_installed" | "not_running";

export class MailEngineUnavailableError extends AppError {
  constructor(
    readonly reason: MailEngineUnavailableReason,
    readonly flavor: MailEngineFlavor,
    message?: string,
  ) {
    super(
      message ??
        (reason === "not_installed"
          ? "This server has no mail engine. Run mail setup on it first."
          : "The mail engine on this server isn't running."),
      409,
      reason === "not_installed" ? "MAIL_ENGINE_NOT_INSTALLED" : "MAIL_ENGINE_NOT_RUNNING",
    );
    this.name = "MailEngineUnavailableError";
  }
}

/**
 * The engine image's idempotent schema bootstrap, at the path the Dockerfile bakes it
 * to, plus the restart it needs to be useful: supervisord's default `startretries=3`
 * has already put Postfix/Dovecot/Amavis in FATAL after their first failed starts
 * against the empty database, and FATAL is terminal.
 *
 * DISPLAY-ONLY — this string is never handed to an executor, which is why the
 * `${MAIL_CONTAINER}` interpolation here is not shell-quoted like every real docker
 * string in this file. It mirrors the second half of what entrypoint.sh prints when the
 * bootstrap fails, so the panel and the container log name the same fix.
 */
const MAIL_DB_BOOTSTRAP_COMMAND =
  `docker exec ${MAIL_CONTAINER} bash /opt/openship-mail/db-bootstrap.sh` +
  ` && docker restart ${MAIL_CONTAINER}`;

/**
 * The engine is up and psql answered — with "there is no schema here".
 *
 * `db-bootstrap.sh` is what seeds `vmail`, and it used to be able to leave without
 * having done so. A box in that state serves SSH, runs the container, and answers every
 * admin read with `relation "domain" does not exist` — which reached the panel as a bare
 * 500 (GH-562). 409 for the same reason as the engine gate above: the request is valid
 * and the box is reachable, the operation just cannot run until one documented command
 * has been. The remediation is IN the message because that is the only place the
 * operator looks.
 *
 * The copy hedges on purpose. `running` comes from `docker inspect .State.Running`,
 * which is true from the instant the container starts — including the whole time the
 * entrypoint is inside db-bootstrap.sh waiting up to 180s for the sidecar. A dashboard
 * poll that lands in that window must not be told confidently to run a repair.
 *
 * A separate class from {@link MailEngineUnavailableError} on purpose: the engine IS
 * installed and running here, so the dashboard's `isMailEngineUnavailable` path — which
 * hides the message in favour of a banner that will not render — must not claim it.
 * Since the entrypoint now exits non-zero when the bootstrap fails, a current-image box
 * lands on `not_running` instead; this is the safety net for an older image, or a
 * `vmail` wiped under a live engine.
 */
export class MailDbNotInitializedError extends AppError {
  constructor(
    readonly flavor: MailEngineFlavor,
    readonly detail: string,
  ) {
    super(
      flavor === "container"
        ? `The mail database on this server has no schema yet (${detail}). If mail setup is still running, wait for it to finish; otherwise the engine's bootstrap did not complete — run: ${MAIL_DB_BOOTSTRAP_COMMAND}`
        : `The mail database on this server has no schema yet (${detail}). Re-run mail setup on this server.`,
      409,
      "MAIL_DB_NOT_INITIALIZED",
    );
    this.name = "MailDbNotInitializedError";
  }
}

/**
 * A mail mutation reached a root-owned host path without a safe route to root.
 * Typed separately from an unavailable engine: the engine is healthy here, but
 * changing its bind-mounted configuration would otherwise fail as an opaque
 * SFTP EACCES.
 */
export class MailConfigPermissionError extends AppError {
  constructor(message?: string) {
    super(
      message ??
        "Changing mail configuration needs root. Connect this server as root, or as a user with passwordless sudo.",
      409,
      "MAIL_CONFIG_PERMISSION_REQUIRED",
    );
    this.name = "MailConfigPermissionError";
  }
}

/**
 * The two namespaces involved in a mail mutation.
 *
 * Host-side config normally belongs to root, but a container-mail operator may
 * explicitly grant the SSH login access to its bind-mount directory. We prove
 * that capability first and otherwise use the existing privilege gate. Engine
 * commands deliberately do NOT inherit host elevation: on the container
 * topology the login user's Docker context/socket is authoritative, and `sudo
 * docker ...` can address a different daemon. A legacy host has no second
 * namespace, so its daemon commands use the privileged executor too.
 */
export interface MailMutationAccess {
  hostFiles: CommandExecutor;
  engineExec: CommandExecutor;
}

export interface MailHostFileRequirement {
  path: string;
  /** Existing content must be readable before it can be safely replaced. */
  read?: boolean;
}

/**
 * A container-mail host path can be managed without root when an operator has
 * deliberately granted access (for example with the ACL workaround from #756).
 * Atomic replacement needs write/search permission on the parent; a read/merge
 * path such as amavis additionally needs the existing file to be readable.
 */
async function loginCanManageMailFiles(
  executor: CommandExecutor,
  requirements: readonly MailHostFileRequirement[],
): Promise<boolean> {
  if (!requirements.length) return false;
  const checks = requirements.map(({ path, read }) => {
    const parent = dirname(path);
    const canReplace = `[ -d ${sq(parent)} ] && [ -w ${sq(parent)} ] && [ -x ${sq(parent)} ]`;
    const canRead = read ? ` && { [ ! -e ${sq(path)} ] || [ -r ${sq(path)} ]; }` : "";
    return `{ ${canReplace}${canRead}; }`;
  });
  const result = await executor
    .exec(
      `if ${checks.join(" && ")}; then echo opsh_mail_access=yes; else echo opsh_mail_access=no; fi`,
    )
    .catch(() => "");
  return result.trim() === "opsh_mail_access=yes";
}

export async function resolveMailMutationAccess(
  executor: CommandExecutor,
  flavor: MailEngineFlavor,
  requirements: readonly MailHostFileRequirement[] = [],
): Promise<MailMutationAccess> {
  // Container commands already run as root INSIDE the engine. If the SSH login
  // can safely replace the host side of every bind-mounted file, no host-root
  // operation remains and an operator-provided ACL is sufficient.
  if (flavor === "container" && (await loginCanManageMailFiles(executor, requirements))) {
    return { hostFiles: executor, engineExec: executor };
  }

  const grant = await privilegedExecutor(executor, "Changing mail configuration", {
    // This operation only edits known paths; it does not install packages or
    // derive commands from the distro. Still measure privilege on an otherwise
    // unsupported host, then refuse explicitly if no route to root exists.
    onRefusedHost: "proceed",
  });
  if (!grant.supported) throw new MailConfigPermissionError(grant.reason);
  if (grant.value.elevation === "none") throw new MailConfigPermissionError();

  return {
    hostFiles: grant.value.executor,
    engineExec: flavor === "container" ? executor : grant.value.executor,
  };
}

/**
 * Atomically replace one host-side mail config file.
 *
 * The optional mode is applied to a unique sibling before rename, so a relay
 * password is never published under the SSH user's umask. When `writer` is the
 * sudo-backed executor its own private 0700 staging path remains the single
 * elevation implementation; this helper only adds the atomic sibling rename.
 */
export async function writeMailConfigFile(
  writer: CommandExecutor,
  path: string,
  content: string,
  opts?: { mode?: number },
): Promise<void> {
  const tmp = `${path}.openship-${randomBytes(8).toString("hex")}`;
  try {
    if (opts === undefined) await writer.writeFile(tmp, content);
    else await writer.writeFile(tmp, content, opts);
    if (writer.rename) await writer.rename(tmp, path);
    else await writer.exec(`mv -f ${sq(tmp)} ${sq(path)}`);
  } catch (err) {
    await writer.rm(tmp).catch(() => undefined);
    throw err;
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const probes = new WeakMap<CommandExecutor, Promise<MailEngineProbe>>();

/**
 * The box's mail topology, memoized per executor. The in-flight promise is what's
 * cached, so concurrent callers on one connection share a single probe.
 */
export async function resolveMailEngine(executor: CommandExecutor): Promise<MailEngineProbe> {
  const cached = probes.get(executor);
  if (cached) return cached;
  // Cache the in-flight promise so concurrent callers on one connection share a
  // single probe — then drop the memo for the two answers that go stale under a
  // pooled executor:
  //   - a throw (transient SSH failure), so it isn't remembered as "no engine";
  //   - a `flavor: "none"`, the state `deploy_engine` ends. A concurrent
  //     `getStatus` poll on the SAME pooled executor probing a box before its
  //     container is up would otherwise pin "none" for the whole 5-min run, and
  //     the DKIM step would refuse with "no mail engine" one line after the
  //     deploy step logged the engine running.
  const pending = detectMailEngine(executor)
    .then((probe) => {
      if (probe.flavor === "none") probes.delete(executor);
      return probe;
    })
    .catch((err: unknown) => {
      probes.delete(executor);
      throw err;
    });
  probes.set(executor, pending);
  return pending;
}

/** Drop the memoized topology for this executor (a command said it was wrong). */
export function forgetMailEngine(executor: CommandExecutor): void {
  probes.delete(executor);
}

/** Run `fn` with a resolved topology, acquiring the executor when given a serverId. */
export async function withMailEngine<T>(
  target: MailTarget,
  fn: (probe: MailEngineProbe, executor: CommandExecutor) => Promise<T>,
): Promise<T> {
  if (typeof target === "string") {
    return sshManager.withExecutor(target, async (executor) =>
      fn(await resolveMailEngine(executor), executor),
    );
  }
  return fn(await resolveMailEngine(target), target);
}

/**
 * Resolve the topology and refuse when the engine can't serve — the gate every
 * write path should sit behind so an operator gets "the engine is stopped, here's
 * the fix" instead of a shell error from three layers down.
 */
export async function requireMailEngine(target: MailTarget): Promise<MailEngineProbe> {
  return withMailEngine(target, async (probe) => {
    assertUsable(probe);
    return probe;
  });
}

function assertUsable(probe: MailEngineProbe): void {
  if (probe.flavor === "none") throw new MailEngineUnavailableError("not_installed", probe.flavor);
  if (!probe.running) throw new MailEngineUnavailableError("not_running", probe.flavor);
}

/**
 * Build a flavor-correct command, run it, and translate a topology failure into
 * the typed error. THE exec chokepoint for mail: every service goes through it,
 * which is what keeps the docker/systemd strings inside this file.
 *
 * `build` receives the resolved flavor and returns the command to run — so a
 * caller that needs its own wrapping (exit-code sentinels, `|| true`, `timeout`)
 * still gets the flavor-correct inner command without knowing the topology.
 */
export async function runMailCommand(
  target: MailTarget,
  build: (flavor: MailEngineFlavor) => string,
  opts: { timeout?: number; requireRunning?: boolean } = {},
): Promise<{ flavor: MailEngineFlavor; output: string }> {
  return withMailEngine(target, async (probe, executor) => {
    if (probe.flavor === "none") {
      throw new MailEngineUnavailableError("not_installed", probe.flavor);
    }
    if (opts.requireRunning !== false && !probe.running) {
      throw new MailEngineUnavailableError("not_running", probe.flavor);
    }

    const command = build(probe.flavor);
    try {
      const output = await executor.exec(
        command,
        opts.timeout ? { timeout: opts.timeout } : undefined,
      );
      // A command can fail without throwing (`|| true`, sentinel wrappers). Check
      // the OUTPUT too, or a stale topology survives every non-throwing caller.
      if (looksLikeWrongFlavor(output, probe.flavor)) {
        throw await reclassify(executor, probe, output);
      }
      return { flavor: probe.flavor, output };
    } catch (err) {
      if (err instanceof MailEngineUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (looksLikeWrongFlavor(message, probe.flavor)) {
        throw await reclassify(executor, probe, message);
      }
      throw err;
    }
  });
}

/**
 * Run SQL against `vmail` on whichever engine this box has — the one funnel every
 * mail-admin read and write goes through (see `admin/psql-runner`).
 *
 * It exists to give a psql failure a TYPE. The flavor is captured as the command is
 * built, so the "no schema" answer can carry the flavor-correct remediation without a
 * second topology probe and without psql-runner learning what a container is. `flavor`
 * stays "none" only when the gate in `runMailCommand` refused before building — the one
 * case where no SQL ran, and one the classifier never sees because that gate throws a
 * typed error.
 */
export async function runMailSql(target: MailTarget, sql: string): Promise<string> {
  let flavor: MailEngineFlavor = "none";
  try {
    const { output } = await runMailCommand(target, (resolved) => {
      flavor = resolved;
      return mailPsqlCommand(resolved, sql);
    });
    return output;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeMissingSchema(message)) {
      // Logged here because the throw below is a 409, and the error handler only logs
      // 5xx — without this line the condition being fixed leaves no trace at all,
      // which is the complaint that opened the issue.
      console.warn(`[mail] vmail schema missing on ${flavor} engine: ${firstOutputLine(message)}`);
      throw new MailDbNotInitializedError(flavor, firstOutputLine(message));
    }
    throw err;
  }
}

/**
 * A psql answer that means the schema was never seeded — a missing `vmail` database
 * (the sidecar initialized, the bootstrap never ran) or a missing table in it (it ran
 * partially). Deliberately NOT `column … does not exist`: that means OUR SQL disagrees
 * with a schema that IS there, which is our bug to read verbatim, not an operator's to
 * bootstrap away.
 */
function looksLikeMissingSchema(text: string): boolean {
  return /database "[^"]+" does not exist|relation "[^"]+" does not exist/i.test(text);
}

/**
 * Does this output mean "you talked to the wrong topology / the engine is gone"?
 *
 * Per-flavor on purpose: docker's "No such container" is conclusive for the
 * container flavor, and on a legacy box the equivalent is `psql`/`sudo` not being
 * there at all. Anything else (a SQL error, a permission problem) is a real
 * failure the caller must keep seeing verbatim.
 */
function looksLikeWrongFlavor(text: string, flavor: MailEngineFlavor): boolean {
  if (!text) return false;
  if (flavor === "container") {
    return /no such container|no such object|is not running|cannot exec in a stopped container|cannot connect to the docker daemon/i.test(
      text,
    );
  }
  if (flavor === "host") {
    return /psql: (command )?not found|command not found: psql|unknown user:? postgres|no such file or directory: sudo/i.test(
      text,
    );
  }
  return false;
}

/**
 * The topology changed under us (a hand-run migration, a removed container).
 * Re-probe once — for the DIAGNOSIS only, never to re-run the command — and
 * report what's actually there now. Re-running is deliberately not done here: a
 * mutation that half-applied must not be replayed against a different engine.
 */
async function reclassify(
  executor: CommandExecutor,
  previous: MailEngineProbe,
  detail: string,
): Promise<MailEngineUnavailableError> {
  forgetMailEngine(executor);
  const fresh = await resolveMailEngine(executor).catch(() => previous);
  if (fresh.flavor === "none") {
    return new MailEngineUnavailableError(
      "not_installed",
      fresh.flavor,
      "The mail engine is no longer on this server — its container is gone. Re-run mail setup to recreate it.",
    );
  }
  return new MailEngineUnavailableError(
    "not_running",
    fresh.flavor,
    `The mail engine on this server isn't serving right now (${firstLine(detail)}).`,
  );
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "no output";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

// ─── The matrix (pure builders — no I/O, so they're unit-testable) ────────────

/** Single-quote a value for safe shell interpolation. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * psql against the `vmail` database.
 *
 * Same database name, same flags, same single shell-quoted `-c` argv on both
 * flavors — only the transport differs. `-A -t` strips headers/alignment;
 * `ON_ERROR_STOP=1` fails loud so `execute()` throws instead of silently
 * half-applying. NEVER a heredoc: a fixed delimiter lets a value containing that
 * delimiter close it early and turn the rest into shell commands.
 */
export function mailPsqlCommand(flavor: MailEngineFlavor, sql: string): string {
  const flags = `-d ${MAIL_DB_NAME} -A -t -v ON_ERROR_STOP=1 -c ${sq(sql)}`;
  // Container: connect as the sidecar's `postgres` superuser (the container-model
  // equivalent of `sudo -u postgres`, which is exactly what legacy boxes use).
  return flavor === "container"
    ? `docker exec ${MAIL_DB_CONTAINER} psql -U postgres ${flags}`
    : `sudo -u postgres psql ${flags}`;
}

/**
 * Run a command where Postfix/Dovecot and their config live — `postmap`,
 * `postconf`, `postfix reload`. On a legacy box that's the host itself.
 */
export function mailEngineCommand(flavor: MailEngineFlavor, cmd: string): string {
  return flavor === "container" ? `docker exec ${MAIL_CONTAINER} ${cmd}` : cmd;
}

/**
 * The three renderers the BACKUP shell needs (GH-563).
 *
 * `mailPsqlCommand` above cannot serve them: it bakes in `-c <sql>`, while a backup
 * streams a dump to stdout and replays a FILE. And a backup script is generated once and
 * executed later by the generic custom_command producer over a bare SSH executor, so it
 * cannot call back into this module — the topology has to be baked into the string.
 *
 * The container case is not simply "prefix with docker exec". Two things differ:
 *
 *   - `-i`. The dump file lives in the producer's `$tmp` ON THE HOST, which the sidecar
 *     cannot see, so the replay has to arrive over stdin (`-f -`) and `docker exec`
 *     needs `-i` to forward it. A `-f "$tmp/…"` inside the container would just be a
 *     missing path.
 *   - WHICH container. Postgres is the sidecar; vmail ownership is the engine. Getting
 *     that pair backwards is how `chown -R vmail:vmail` ran somewhere with no vmail user.
 */
/**
 * Just the topology, for callers that GENERATE a command instead of running one — the
 * backup plan is built now and executed later, elsewhere, by the generic producer.
 * `requireRunning` is deliberately not implied: a backup policy can legitimately be
 * saved while the engine is stopped.
 */
export async function resolveMailFlavor(target: MailTarget): Promise<MailEngineFlavor> {
  return withMailEngine(target, async (probe) => {
    if (probe.flavor === "none") {
      throw new MailEngineUnavailableError("not_installed", probe.flavor);
    }
    return probe.flavor;
  });
}

export function mailPgDumpToStdout(flavor: MailEngineFlavor, args: string): string {
  return flavor === "container"
    ? `docker exec ${MAIL_DB_CONTAINER} pg_dump -U postgres -d ${MAIL_DB_NAME} ${args}`
    : `sudo -u postgres pg_dump -d ${MAIL_DB_NAME} ${args}`;
}

/** psql reading SQL from STDIN, so the caller redirects a host-side file into it. */
export function mailPsqlFromStdin(flavor: MailEngineFlavor): string {
  const flags = `-d ${MAIL_DB_NAME} -v ON_ERROR_STOP=1 -f -`;
  return flavor === "container"
    ? `docker exec -i ${MAIL_DB_CONTAINER} psql -U postgres ${flags}`
    : `sudo -u postgres psql ${flags}`;
}

/**
 * Pick the restored mail data up. The engine reads its accounts from Postgres and its
 * config from the bind-mounted /etc paths, so a restore is inert until the daemons
 * re-read both — `supervisorctl` in the container, `systemctl` on a legacy host. The
 * supervisord program names are deliberately the same strings as the health probe's
 * units (see mail-health.service.ts), so there is one vocabulary, not two.
 */
export function mailDaemonReloadCommand(flavor: MailEngineFlavor): string {
  return flavor === "container"
    ? `docker exec ${MAIL_CONTAINER} supervisorctl restart postfix dovecot amavis`
    : "systemctl reload postfix dovecot 2>/dev/null; systemctl restart amavis 2>/dev/null";
}

/**
 * The path each editable config file has INSIDE the engine.
 *
 * The engine is our own Debian-based `openship-mail` image, so these are fixed — and
 * they are *also* correct for a legacy Debian-family host, which is where the
 * "(= on a legacy host)" this comment used to claim came from. It is NOT correct for a
 * legacy RHEL-family box, whose amavis has no `conf.d` include dir at all; that one path
 * is resolved by probing the box instead — see {@link HOST_AMAVIS_CONF_CANDIDATES}. The
 * postfix paths need no such treatment: `/etc/postfix` is postfix's config dir on every
 * family Openship supports.
 */
const MAIL_ENGINE_PATHS = {
  saslPasswd: "/etc/postfix/sasl_passwd",
  senderRelayhost: "/etc/postfix/sender_relayhost",
  relayTlsPolicy: "/etc/postfix/openship_tls_policy",
  amavisUserConf: "/etc/amavis/conf.d/50-user",
} as const satisfies Record<keyof typeof MAIL_HOST_PATHS, string>;

/**
 * Where amavis keeps its editable config on a LEGACY host install, most specific first.
 *
 * Probed rather than derived from the host's `distroFamily`, because what differs across
 * families is the include *mechanism*, not just a path: the Debian family ships a
 * `conf.d` directory and expects an override file in it, while the RHEL family has no
 * such directory and keeps one monolithic `amavisd.conf`. The packaged layout also moves
 * between iRedMail versions on the same distro. So the box is asked, and a location we
 * cannot see is refused rather than assumed.
 *
 * The bug this replaces was silent by construction: on a RHEL-family box we wrote
 * `dkim_key(...)` into `/etc/amavis/conf.d/50-user`, a file amavis never reads, and every
 * step reported success while outbound mail went out unsigned.
 */
export const HOST_AMAVIS_CONF_CANDIDATES = [
  // The include dir, not the file: 50-user is ours to create, so requiring it to exist
  // already would reject a box that simply hasn't been given an override yet.
  { test: "-d /etc/amavis/conf.d", path: "/etc/amavis/conf.d/50-user" },
  { test: "-f /etc/amavisd/amavisd.conf", path: "/etc/amavisd/amavisd.conf" },
  { test: "-f /etc/amavisd.conf", path: "/etc/amavisd.conf" },
] as const;

/**
 * `sh` fragment emitting `conf=<path>` for the first candidate this box has.
 *
 * Emits nothing when there is none — the caller's "no `conf=` line" branch is the
 * refusal, so a box we can't place amavis on cannot be mistaken for one we can.
 */
export const HOST_AMAVIS_CONF_PROBE: string = HOST_AMAVIS_CONF_CANDIDATES.map(
  (c, i) => `${i === 0 ? "if" : "elif"} [ ${c.test} ]; then echo "conf=${c.path}"`,
).join("; ") + "; fi";

/**
 * Where an editable daemon config file lives on each side.
 *
 * `write` is the path to WRITE (always a real host path — `exec.writeFile` uses
 * SFTP with no shell, the SASL-password security invariant); `engine` is the path
 * the daemon itself sees, which is what `postmap` / `postconf` / a `dkim_key(...)`
 * directive must reference. On the container flavor those are the two ends of a
 * bind mount (`MAIL_CONTAINER_MOUNTS`); on a legacy box they're the same file.
 */
export function mailConfigFile(
  flavor: MailEngineFlavor,
  file: keyof typeof MAIL_ENGINE_PATHS,
): { write: string; engine: string } {
  const engine = MAIL_ENGINE_PATHS[file];
  return flavor === "container" ? { write: MAIL_HOST_PATHS[file], engine } : { write: engine, engine };
}

// ─── Daemon state ────────────────────────────────────────────────────────────

/*
 * The `host` arms below are systemd-shaped on purpose, and the gate is upstream.
 *
 * `detectMailEngine` only returns `flavor: "host"` after `systemctl show` reported the
 * legacy units as loaded, so a box with no systemd resolves to `none` and never reaches
 * here. That is why these keep their literal `systemctl` / `journalctl` strings instead of
 * going through `envOps().serviceIsActive()` etc.: routing them would add a SECOND opinion
 * about whether this box runs systemd, which could disagree with the probe that chose the
 * flavor in the first place — and the two facts they depend on have no cross-distro form.
 * `systemctl show -p LoadState -p ActiveState -p SubState -p ActiveEnterTimestamp` is four
 * properties one parser reads together, not an is-active; and `--no-block` is what lets
 * "restart all" kick every unit without waiting on a slow one.
 */

/** Normalized daemon state, shared by both flavors' probes. */
export type MailUnitStatus =
  | "active"
  | "inactive"
  | "failed"
  | "activating"
  | "deactivating"
  | "missing"
  | "unknown";

export interface MailUnitState {
  status: MailUnitStatus;
  /**
   * The supervisor's own state word — systemd's SubState, or supervisord's,
   * lower-cased. Load-bearing beyond display: `status: "failed"` covers both
   * supervisord FATAL (it has given up) and BACKOFF (it is still retrying), and
   * this is the only thing that tells them apart.
   */
  subState?: string;
  /** ISO timestamp the unit entered its current state — systemd only. */
  activeSince?: string;
  /** Why the status is `unknown` — the probe's own words. */
  detail?: string;
}

/**
 * Probe one daemon. `key` selects the DB special case (a sidecar container vs a
 * plain systemd unit); `unit` is the supervisord program name, which the engine
 * image deliberately keeps identical to the legacy systemd unit name so one
 * catalog (`MAIL_COMPONENTS`) serves both flavors.
 *
 * `2>&1 || true` on purpose: the probe's own failure has to stay readable, or an
 * unreachable daemon is indistinguishable from an uninstalled one.
 */
export function mailUnitProbeCommand(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
): string {
  if (flavor === "container") {
    return key === "postgresql"
      ? `docker inspect -f '{{.State.Running}}' ${sq(MAIL_DB_CONTAINER)} 2>&1 || true`
      : `docker exec ${sq(MAIL_CONTAINER)} supervisorctl status ${sq(unit)} 2>&1 || true`;
  }
  return `systemctl show ${sq(unit)} -p LoadState -p ActiveState -p SubState -p ActiveEnterTimestamp 2>&1 || true`;
}

/** Parse whatever {@link mailUnitProbeCommand} produced into a normalized state. */
export function parseMailUnitProbe(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
  raw: string,
): MailUnitState {
  if (flavor === "container") {
    if (key === "postgresql") {
      // The verdict may not be the FIRST line: `2>&1` (deliberate — see
      // mailUnitProbeCommand) folds the CLI's stderr into the stream, and docker
      // prints its warnings ("WARNING: Error loading config file: …",
      // `level=warning` notices) ahead of the inspect result. Judging line one
      // turned a healthy sidecar into a required-component failure that halted
      // mail setup (#783). The template prints exactly `true` or `false`, so an
      // exact line match anywhere in the output is the daemon's answer and
      // nothing else's — the same past-the-noise reading the supervisorctl and
      // systemd branches below already do.
      const lines = raw.split("\n").map((l) => l.trim());
      if (lines.includes("true")) return { status: "active" };
      if (lines.includes("false")) return { status: "inactive" };
      // Only docker saying the container isn't there means missing. A refused
      // daemon or a permission error is a probe we can't conclude from.
      if (/no such object|no such container/i.test(raw)) return { status: "missing" };
      return { status: "unknown", detail: firstOutputLine(raw) || "probe returned no output" };
    }
    // supervisord always names the program it reports on — "postfix RUNNING pid 12,
    // uptime 0:03:11", or "postfix: ERROR (no such process)". No such line means
    // supervisord never answered (engine down, docker unreachable, exec refused),
    // which is UNKNOWN: calling it "missing" blames the daemon for a docker problem.
    const stateLine = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l === unit || l.startsWith(`${unit} `) || l.startsWith(`${unit}:`));
    if (!stateLine) {
      return { status: "unknown", detail: firstOutputLine(raw) || "probe returned no output" };
    }
    if (/no such process/i.test(stateLine)) return { status: "missing" };
    const word = stateLine.split(/\s+/)[1] ?? "";
    return { status: mapSupervisorState(word), subState: word.toLowerCase() || undefined };
  }

  const props = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) props.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const load = props.get("LoadState");
  if (!load) {
    return { status: "unknown", detail: firstOutputLine(raw) || "probe returned no output" };
  }
  if (load === "not-found") return { status: "missing" };
  const activeState = props.get("ActiveState") ?? "";
  const since = props.get("ActiveEnterTimestamp");
  return {
    status: mapActiveState(activeState),
    subState: props.get("SubState") || undefined,
    activeSince: parseSystemdTimestamp(since),
  };
}

/**
 * Act on one daemon. Both flavors return the instant the supervisor accepts the
 * job (`--no-block` / supervisorctl's own behaviour) — a `systemctl restart
 * dovecot` that waits for stuck IMAP workers outlives the SSH command timeout.
 */
export function mailUnitActionCommand(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
  action: "start" | "stop" | "restart",
): string {
  if (flavor === "container") {
    return key === "postgresql"
      ? `docker ${action} ${sq(MAIL_DB_CONTAINER)}`
      : `docker exec ${sq(MAIL_CONTAINER)} supervisorctl ${action} ${sq(unit)}`;
  }
  return `systemctl --no-block ${action} ${sq(unit)}`;
}

/**
 * The outbound queue, as `postqueue -p` prints it.
 *
 * Only `postqueue` itself has to run inside the engine — the pipeline is the OUTER
 * shell's (the pipe in `docker exec … postqueue -p | tail` is interpreted on the
 * host), so one string serves both flavors.
 *
 * Bounded on purpose: a box that has been deferring for a week can hold thousands
 * of entries, and this runs on a 10-second poll. `tail` keeps the summary line
 * (postqueue prints it last, and it counts the WHOLE queue regardless of what we
 * read) while capping the per-message lines we sample reasons from.
 */
export function mailQueueProbeCommand(flavor: MailEngineFlavor, lines = 400): string {
  return `timeout 10 ${mailEngineCommand(flavor, "postqueue -p")} 2>&1 | tail -n ${lines} || true`;
}

/**
 * Tail one daemon's logs — the command to run, and the same read in the form we
 * show the operator.
 *
 * supervisord writes each program to `/var/log/supervisor/<program>.log` (see
 * apps/email's supervisord.conf); the sidecar logs to its container; a legacy box
 * has journald. `timeout 10` caps the exec so a hung log can't sit on the SSH
 * channel.
 *
 * `source` exists because the drawer printed a hardcoded `journalctl -u …` header,
 * naming a log the container engine does not have. Both halves come out of this one
 * switch, so the header cannot drift from the read; `source` drops the `timeout`,
 * the redirection and the shell quoting, and nothing else. The log path keeps
 * `${unit}` unquoted deliberately — it is closed over by `MAIL_COMPONENTS`, not
 * caller input.
 */
export function mailUnitLogsRead(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
  lines: number,
): { command: string; source: string } {
  if (flavor === "container") {
    if (key === "postgresql") {
      const source = `docker logs --tail ${lines} ${MAIL_DB_CONTAINER}`;
      return { command: `timeout 10 ${source} 2>&1 || true`, source };
    }
    const source = `docker exec ${MAIL_CONTAINER} tail -n ${lines} /var/log/supervisor/${unit}.log`;
    return { command: `timeout 10 ${source} 2>/dev/null || true`, source };
  }
  return {
    command: `timeout 10 journalctl -u ${sq(unit)} -n ${lines} --no-pager 2>&1 || true`,
    source: `journalctl -u ${unit} -n ${lines}`,
  };
}

function firstOutputLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function mapSupervisorState(s: string): MailUnitStatus {
  switch (s.toUpperCase()) {
    case "RUNNING":
      return "active";
    case "STOPPED":
    case "EXITED":
      return "inactive";
    // Both are `failed` for every consumer that grades this — the deploy gate, the
    // serving check, the Health banner. What differs is whether anything is still
    // trying, and that rides on `subState`: FATAL means supervisord has given up.
    case "FATAL":
    case "BACKOFF":
      return "failed";
    case "STARTING":
      return "activating";
    case "STOPPING":
      return "deactivating";
    default:
      return "unknown";
  }
}

function mapActiveState(s: string): MailUnitStatus {
  switch (s) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    case "failed":
      return "failed";
    case "activating":
    case "reloading":
      return "activating";
    case "deactivating":
      return "deactivating";
    default:
      return "unknown";
  }
}

/**
 * systemd prints `ActiveEnterTimestamp=Tue 2026-08-04 14:22:05 UTC` (and an empty
 * value for a unit that never started). Return an ISO string when it parses, and
 * nothing when it doesn't — a malformed timestamp must not become an invalid Date
 * in the API response.
 */
function parseSystemdTimestamp(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = new Date(raw.replace(/^[A-Za-z]{3}\s+/, ""));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
