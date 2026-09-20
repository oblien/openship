import type { CommandExecutor } from "../types";
import { formatDuration, systemDebug } from "./debug";
import { EXECUTOR_DELEGATE } from "./elevated-executor";
import { isRemoteConnectionError } from "./errors";
import { safeErrorMessage } from "@repo/core";

/**
 * The vocabulary lives in `@repo/core/host-profile` — the dashboard consumes the
 * firewall union and cannot import this package. Re-exported here so every existing
 * `from "./environment"` import keeps resolving; this module owns the *measuring*,
 * core owns the shapes, and `environment-ops.ts` owns the commands.
 */
export type {
  DistroFamily,
  EnvironmentProfile,
  LinuxDistro,
  SystemArch,
  SystemFirewall,
  SystemLibc,
  SystemOs,
  SystemPackageManager,
  SystemSelinux,
  SystemServiceManager,
} from "@repo/core";

import type {
  EnvironmentProfile,
  SystemFirewall,
  SystemLibc,
  SystemPackageManager,
  SystemSelinux,
  SystemServiceManager,
} from "@repo/core";
import {
  assessHostSupport,
  classifyDistro,
  parseOsRelease,
  parseSystemArch,
  parseSystemOs,
} from "@repo/core";

/**
 * Every host fact in one round-trip.
 *
 * This used to be up to eleven sequential `exec` calls — the package-manager probe
 * alone was a five-step ladder, so detecting a Debian box cost five execs to rule out
 * `brew`. At the 5s-per-probe timeout that was a 55s worst case for facts that one
 * shell can establish in milliseconds. The old comment warning against *parallel* SSH
 * channels (one channel error triggers `resetConnection()` and kills the rest) still
 * holds and is not violated here: one channel is strictly safer than eleven.
 *
 * Rules this script obeys, because the hosts it runs on are unforgiving:
 *
 * - **POSIX `sh` only.** Alpine is busybox `ash`: no `[[`, no arrays, no `local -n`.
 * - **Every probe is `|| true`-guarded and emits its key unconditionally**, so a box
 *   that lacks a binary yields an empty value rather than aborting the script. A
 *   partial answer still parses, and an odd host degrades into `supported: false`
 *   instead of throwing somewhere deep in provisioning.
 * - **It always exits 0.** A non-zero exit therefore means something ran *instead of*
 *   this script, which is how the sshd forced-command case is detected.
 * - **`opsh_begin` / `opsh_end` bracket the output.** Their absence — not a match on
 *   any particular vendor's wording — is the interception signal.
 * - **No `${...}` param expansion**, so it embeds cleanly in this template literal
 *   (the house rule `remote-journal.ts` already follows).
 *
 * `/etc/os-release` is forwarded verbatim, one line per `opsh_osr:` prefix, so the
 * quote-stripping and key-casing happen once in `parseOsRelease` against real strings
 * rather than being reimplemented in sed.
 */
export const ENVIRONMENT_PROBE_SCRIPT = `echo "opsh_begin=1"
# Appended, never replaced: \`ufw\`, \`nft\` and \`iptables\` live in /usr/sbin, which is off
# a non-root user's PATH on Debian — so "no firewall installed" was sometimes just "not on
# this user's PATH", and the box came back \`unknown\`.
PATH="$PATH:/usr/sbin:/sbin"
echo "opsh_os=$(uname -s 2>/dev/null || true)"
echo "opsh_arch=$(uname -m 2>/dev/null || true)"
echo "opsh_uid=$(id -u 2>/dev/null || true)"
echo "opsh_user=$(id -un 2>/dev/null || true)"
echo "opsh_home=$HOME"

OSR=/etc/os-release
[ -r "$OSR" ] || OSR=/usr/lib/os-release
# awk and not sed: \`print\` always terminates its record, while sed reproduces the input
# byte for byte — and an os-release with no trailing newline glued the next \`echo\` onto
# the last forwarded line, so \`opsh_pm\` vanished and a working apt host was refused for
# having no package manager, brackets intact and nothing to flag it.
[ -r "$OSR" ] && awk '{ print "opsh_osr:" $0 }' "$OSR" 2>/dev/null || true

PM=none
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v apk >/dev/null 2>&1; then PM=apk
elif command -v brew >/dev/null 2>&1; then PM=brew
fi
echo "opsh_pm=$PM"

SM=none
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then SM=systemd
elif command -v rc-service >/dev/null 2>&1; then SM=openrc
elif command -v launchctl >/dev/null 2>&1; then SM=launchd
fi
echo "opsh_sm=$SM"

SUDO=n
if [ "$(id -u 2>/dev/null)" != 0 ]; then
  sudo -n true >/dev/null 2>&1 && SUDO=y
fi
echo "opsh_sudo=$SUDO"

# Established BEFORE the firewall probes, because reading a ruleset is privileged:
# \`iptables -S\` and \`firewall-cmd --state\` refuse outright for an unprivileged user, and a
# refused read used to come back as "no firewall" — the one answer that makes us skip
# opening a port. \`-n\` so a box without passwordless sudo fails instead of waiting for a
# password on a channel with no TTY, and every elevated command below is a READ.
PRIV=
[ "$SUDO" = y ] && PRIV="sudo -n"

HAS_UFW=n; HAS_FWD=n; HAS_NFT=n; HAS_IPT=n
command -v ufw >/dev/null 2>&1 && HAS_UFW=y
command -v firewall-cmd >/dev/null 2>&1 && HAS_FWD=y
command -v nft >/dev/null 2>&1 && HAS_NFT=y
command -v iptables >/dev/null 2>&1 && HAS_IPT=y
FW=unknown
if [ "$HAS_UFW" = y ]; then
  case "$($PRIV ufw status 2>/dev/null || true)" in *"Status: active"*) FW=ufw ;; esac
  if [ "$FW" = unknown ] && grep -qiE "^[[:space:]]*ENABLED[[:space:]]*=[[:space:]]*yes" /etc/ufw/ufw.conf 2>/dev/null; then FW=ufw; fi
fi
if [ "$FW" = unknown ] && [ "$HAS_FWD" = y ]; then
  case "$($PRIV firewall-cmd --state 2>/dev/null || true)" in *running*) FW=firewalld ;; esac
fi
if [ "$FW" = unknown ] && [ "$HAS_NFT" = y ]; then
  case "$($PRIV nft list tables 2>/dev/null || true)" in *"table inet filter"*) FW=nftables ;; esac
fi
if [ "$FW" = unknown ] && [ "$HAS_IPT" = y ]; then
  IPT="$($PRIV iptables -S INPUT 2>/dev/null || true)"
  case "$IPT" in
    *"-P INPUT DROP"*) FW=iptables ;;
    # A permissive POLICY does not mean a permissive CHAIN. RHEL's stock ruleset and every
    # hand-written iptables-persistent file end INPUT in a catch-all reject with the policy
    # left at ACCEPT, and reading the policy alone reported those hosts as unfirewalled —
    # so nothing opened a port and the service came up unreachable. Any terminal drop counts:
    # a single banned IP over-reports slightly, and over-reporting only costs a warning
    # while under-reporting costs the port. (There is deliberately no \`-P INPUT REJECT\`
    # arm: netfilter has no such built-in policy, so the old one was unreachable.)
    *"-P INPUT "*)
      if printf '%s\\n' "$IPT" | grep -qE '^-A INPUT .*-j (DROP|REJECT)'; then FW=iptables; else FW=none; fi
      ;;
  esac
fi
if [ "$FW" = unknown ] && [ "$HAS_UFW$HAS_FWD$HAS_NFT$HAS_IPT" = nnnn ]; then FW=none; fi
echo "opsh_fw=$FW"

LIBC=unknown
if command -v ldd >/dev/null 2>&1; then
  case "$(ldd --version 2>&1 || true)" in
    *musl*) LIBC=musl ;;
    *GNU*|*GLIBC*|*glibc*) LIBC=glibc ;;
  esac
fi
echo "opsh_libc=$LIBC"

SEL=absent
if command -v getenforce >/dev/null 2>&1; then
  SEL=disabled
  case "$(getenforce 2>/dev/null || true)" in
    Enforcing*) SEL=enforcing ;;
    Permissive*) SEL=permissive ;;
  esac
fi
echo "opsh_selinux=$SEL"

CT=n
[ -f /.dockerenv ] && CT=y
[ -f /run/.containerenv ] && CT=y
if [ "$CT" = n ] && grep -qaE "(docker|lxc|containerd|kubepods|libpod)" /proc/1/cgroup 2>/dev/null; then CT=y; fi
if [ "$CT" = n ] && command -v systemd-detect-virt >/dev/null 2>&1; then
  systemd-detect-virt --container --quiet >/dev/null 2>&1 && CT=y
fi
echo "opsh_container=$CT"

echo "opsh_end=1"
exit 0`;

/**
 * One budget for the whole probe, replacing eleven 5s budgets. Generous rather than
 * tight: `ufw status` and `iptables -S` shell out to the kernel and a loaded box can
 * be slow, and a probe that times out costs a `supported: false` on a fine host.
 */
export const ENVIRONMENT_PROBE_TIMEOUT_MS = 20_000;

/** How much intercepted output to quote back at the operator. Enough to recognize it. */
const MAX_INTERCEPT_CHARS = 400;

/**
 * How long one measurement is trusted.
 *
 * A profile used to live exactly as long as the executor OBJECT did, which is a lifetime
 * nobody chose: a warm server connection is pooled for days, so a box measured once at
 * process start is driven on that answer until the API restarts. Nothing Openship installs
 * changes a field here — but the operator does. Adding their login to a sudo group,
 * enabling ufw, installing a package manager on a bare image: all invisible, and all
 * things they do specifically BECAUSE Openship told them to, then retry.
 *
 * Five minutes is chosen from that retry loop, not from a cost model. Re-measuring is one
 * `sh -c` on an already-open channel, so the ceiling on the other side is "wait a moment
 * and try again" — short enough to be a plausible instruction, long enough that a single
 * deploy re-probes at most once or twice.
 */
export const ENVIRONMENT_PROFILE_TTL_MS = 5 * 60_000;

/** Whether a measurement taken then may still be used now. Spelled once, used by the
 *  async cache below and by `environment-local.ts`'s sync memo. */
export function profileIsFresh(measuredAt: number): boolean {
  return Date.now() - measuredAt < ENVIRONMENT_PROFILE_TTL_MS;
}

/**
 * One host's measurement, with the timestamp that gives it a lifetime.
 *
 * `measuredAt` is stamped when the probe STARTS, not when it lands, and both halves of
 * that matter. Callers arriving during the round trip find a fresh entry and join the
 * in-flight promise rather than each opening their own channel. And it is deliberately
 * NOT corrected backwards when the probe fails and the keep-previous arm hands back an
 * older profile: that stamp is what rate-limits the retry to one per window. Restore the
 * old age instead and the entry is stale again immediately, so a wedged box is probed
 * once per resolve, each attempt paying the full timeout on the one serial channel.
 */
interface CachedProfile {
  readonly measuredAt: number;
  readonly profile: Promise<EnvironmentProfile>;
}

const profileCache = new WeakMap<CommandExecutor, CachedProfile>();

/**
 * The raw shape of one probe, before it becomes a profile.
 *
 * Split out from `buildProfile` so `environment-local.ts` can run the same script
 * through `spawnSync` and reach the same profile — sync and async differ only in how
 * they execute one string, and two parsers would be two answers.
 */
export interface EnvironmentProbe {
  /** Whatever came back: stdout, or the failure text when the command exited non-zero. */
  text: string;
  /** The command itself failed (non-zero exit). Not a transport fault — those throw. */
  failed: boolean;
  /**
   * Nothing answered: the probe timed out, or its channel was torn down mid-command.
   *
   * Distinct from `failed`, and the distinction is the whole point — a non-zero exit
   * carries the HOST's output (the AWS AMI's forced command prints its banner and exits
   * 142), while this carries OURS. `text` is a timeout message here, so treating it as the
   * host's answer diagnoses an sshd forced command and quotes our own probe script as the
   * thing the host supposedly said.
   */
  unanswered: boolean;
}

/**
 * Our own diagnostic rather than the host's answer.
 *
 * Deliberately local instead of reusing `isRemoteConnectionError`: that classifier answers
 * "should the caller retry on a fresh connection", and a per-command timeout is not a
 * transport fault — the box is reachable, it was just slow. Widening it to match would
 * change every retry loop in the repo to fix one message here. Lowercased because the
 * executors spell it `Command timed out after Nms` while ssh2 says `Timed out`.
 */
function isUnansweredProbe(message: string): boolean {
  const text = message.trim().toLowerCase();
  // Narrow on purpose. A forced command's banner is arbitrary operator text, and anything
  // that matched loosely here would reclassify the origin bug as "slow host" — so only
  // phrasings our own code produces are listed.
  if (text.includes("timed out") || text.includes("without an exit status")) return true;
  return EXIT_STATUS_ONLY.test(text);
}

/**
 * The executors' last-resort failure text, which carries no host output at all.
 *
 * Every one of them spells the same fallback — `detail || \`Exit code ${code}\`` — so
 * reaching this shape means the command wrote to neither stream. `null` is the case
 * observed in the field: ssh2 reports no code when the process is killed by a signal
 * (an OOM kill, a torn-down channel, a `ForceCommand` that kills the shell before it
 * runs), and reading `"Exit code null"` as the host's answer diagnosed an sshd forced
 * command and quoted our own error string as the thing the box said.
 */
const EXIT_STATUS_ONLY = /^exit code (?:-?\d+|null|undefined)$/;

/** Stands in for the host's answer when there wasn't one, so the refusal has a fact to quote. */
const SILENT_PROBE = "the probe produced no output at all";

async function runProbe(executor: CommandExecutor): Promise<EnvironmentProbe> {
  const startedAt = Date.now();
  systemDebug("environment", "probe:start");
  try {
    const text = await executor.exec(ENVIRONMENT_PROBE_SCRIPT, {
      timeout: ENVIRONMENT_PROBE_TIMEOUT_MS,
    });
    systemDebug("environment", `probe:ok (${formatDuration(startedAt)}) ${text.length}b`);
    return { text, failed: false, unanswered: false };
  } catch (err) {
    // Unchanged contract: a transport fault is the caller's to handle (it means the
    // box is unreachable, not unsupported), while a command failure is a fact ABOUT
    // the box and its text is the most useful thing we have.
    if (isRemoteConnectionError(err)) {
      systemDebug(
        "environment",
        `probe:abort (${formatDuration(startedAt)}) ${safeErrorMessage(err)}`,
      );
      throw err;
    }
    const message = safeErrorMessage(err);
    systemDebug("environment", `probe:fail (${formatDuration(startedAt)}) ${message}`);
    return { text: message, failed: true, unanswered: isUnansweredProbe(message) };
  }
}

/**
 * A union's members as a runtime list, checked to BE the union.
 *
 * `readonly SystemPackageManager[]` is satisfied by any subset, so the lists below used to
 * be the one half of this layer where adding a member was NOT a compile error: the command
 * tables would refuse to build, while the parser quietly narrowed the new value to its
 * fallback and every host running it reported `none`. That is the original bug — a table
 * that didn't list your host — one layer down. `Record<T, true>` over a literal makes a
 * missing key TS2741 and a stray key TS2353.
 */
function members<T extends string>(all: Record<T, true>): readonly T[] {
  return Object.keys(all) as T[];
}

const PACKAGE_MANAGERS = members<SystemPackageManager>({
  apt: true,
  dnf: true,
  yum: true,
  apk: true,
  brew: true,
  none: true,
});
const SERVICE_MANAGERS = members<SystemServiceManager>({
  systemd: true,
  openrc: true,
  launchd: true,
  none: true,
});
const FIREWALLS = members<SystemFirewall>({
  ufw: true,
  firewalld: true,
  nftables: true,
  iptables: true,
  none: true,
  unknown: true,
});
const LIBCS = members<SystemLibc>({ glibc: true, musl: true, unknown: true });
const SELINUX_STATES = members<SystemSelinux>({
  enforcing: true,
  permissive: true,
  disabled: true,
  absent: true,
});

/**
 * Narrow a probe value to its union, or fall back.
 *
 * The script and the unions are two halves of one contract that a typo can split, and
 * a raw cast would let `opsh_pm=aptt` through as a `SystemPackageManager`. The fallback
 * is always the honest member (`none`/`unknown`), never a guess at what was meant.
 */
function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const found = allowed.find((member) => member === value?.trim());
  return found ?? fallback;
}

/**
 * Reassemble the probe's `key=value` lines and its forwarded os-release.
 *
 * `opsh_`-prefixed keys mean output a forced command would have to reproduce by
 * accident to be mistaken for ours.
 */
function splitProbeOutput(text: string): {
  keys: Record<string, string>;
  osRelease: string;
} {
  const keys: Record<string, string> = {};
  const osReleaseLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("opsh_osr:")) {
      osReleaseLines.push(line.slice("opsh_osr:".length));
      continue;
    }
    if (!line.startsWith("opsh_")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    keys[line.slice(0, eq)] = line.slice(eq + 1).trimEnd();
  }
  return { keys, osRelease: osReleaseLines.join("\n") };
}

/**
 * What answered, when it wasn't our script.
 *
 * Deliberately not a match on any vendor's wording. The AWS AMI prints `Please login
 * as the user "ec2-user"` and exits 142, but a differently-worded forced command is the
 * same fault, and pattern-matching the one we've seen would read every other one as an
 * empty box. The signal is structural: our brackets are missing.
 */
function summarizeInterception(text: string): string | null {
  const collapsed = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (!collapsed) return null;
  return collapsed.length > MAX_INTERCEPT_CHARS
    ? `${collapsed.slice(0, MAX_INTERCEPT_CHARS)}…`
    : collapsed;
}

/** Probe output → one host. Pure, so both the SSH and the local path land identically. */
export function parseEnvironmentProbe(probe: EnvironmentProbe): EnvironmentProfile {
  const { keys, osRelease } = splitProbeOutput(probe.text);
  const complete = keys.opsh_begin === "1" && keys.opsh_end === "1";

  // Three outcomes, not two. Everything below is meaningless unless the script itself
  // answered, and the two ways it can fail to are not the same fault: something ran
  // INSTEAD of it (the text is the host's, and naming it is the whole point), or nothing
  // ran to completion (the text is our own timeout message). Collapsing them told the
  // operator of a merely-slow box that their sshd runs a forced command, and quoted our
  // probe script back at them as the evidence.
  //
  // Which of the two it is turns on whether there is any host text to attribute, not on
  // matching a message: `summarizeInterception` returning null means the box printed
  // nothing, so there is nothing an operator could read as their forced command's banner.
  const said = complete ? null : summarizeInterception(probe.text);
  const unanswered = !complete && (probe.unanswered || said === null);
  const forcedCommand = unanswered ? null : said;
  const probeError = unanswered ? (said ?? SILENT_PROBE) : null;

  const os = complete ? parseSystemOs(keys.opsh_os) : "unknown";
  const osRaw = complete ? keys.opsh_os?.trim() || null : null;
  const archRaw = complete ? keys.opsh_arch?.trim() || null : null;
  const arch = complete ? parseSystemArch(keys.opsh_arch) : "unknown";

  const osReleaseFields = parseOsRelease(osRelease);
  const distroId = osReleaseFields.ID ?? null;
  const { distro, family } = classifyDistro(distroId, osReleaseFields.ID_LIKE);

  const isRoot = keys.opsh_uid?.trim() === "0";
  const loginUser = keys.opsh_user?.trim() || (isRoot ? "root" : "");
  const home =
    keys.opsh_home?.trim() || (isRoot ? "/root" : loginUser ? `/home/${loginUser}` : "");

  const packageManager = oneOf(keys.opsh_pm, PACKAGE_MANAGERS, "none");

  const profile: EnvironmentProfile = {
    os,
    osRaw,
    arch,
    archRaw,
    // `distro` stays null off Linux, where the concept doesn't apply — the existing
    // contract every call site was written against.
    distro: os === "linux" ? distro : null,
    distroFamily: os === "linux" ? family : "unknown",
    distroId,
    versionId: osReleaseFields.VERSION_ID ?? null,
    prettyName: osReleaseFields.PRETTY_NAME ?? null,
    packageManager,
    serviceManager: oneOf(keys.opsh_sm, SERVICE_MANAGERS, "none"),
    firewall: oneOf(keys.opsh_fw, FIREWALLS, "unknown"),
    libc: oneOf(keys.opsh_libc, LIBCS, "unknown"),
    selinux: oneOf(keys.opsh_selinux, SELINUX_STATES, "absent"),
    isContainer: keys.opsh_container?.trim() === "y",
    isRoot,
    // Meaningless when root, and the script never probes sudo in that case — the
    // deliberate `false` the previous detector also returned.
    canSudo: !isRoot && keys.opsh_sudo?.trim() === "y",
    loginUser,
    home,
    forcedCommand,
    probeError,
    supported: false,
    unsupportedReason: null,
  };

  return { ...profile, ...assessHostSupport(profile) };
}

/**
 * The cache key for a host, as opposed to for a *view* of one.
 *
 * Decorators (`elevatedExecutor`) return a Proxy, so the same box arrives under several
 * object identities. Unwrapping to the delegate means one probe per box and removes the
 * failure mode where an elevated and an unelevated view disagree about `canSudo`. The
 * hop limit is a cycle guard, not a depth policy — decorators nest at most twice today.
 */
export function cacheKeyFor(executor: CommandExecutor): CommandExecutor {
  let root = executor;
  for (let hops = 0; hops < 8; hops += 1) {
    const delegate = (root as unknown as Record<symbol, unknown>)[EXECUTOR_DELEGATE];
    if (!delegate || delegate === root) break;
    root = delegate as CommandExecutor;
  }
  return root;
}

export async function resolveEnvironment(
  executor: CommandExecutor,
): Promise<EnvironmentProfile> {
  const key = cacheKeyFor(executor);
  const cached = profileCache.get(key);
  if (cached && profileIsFresh(cached.measuredAt)) {
    systemDebug("environment", "cache:hit");
    return cached.profile;
  }

  systemDebug("environment", cached ? "cache:stale" : "cache:miss");
  const promise = (async () => {
    // `key`, not `executor`: the cache key must also be the thing measured. Unwrapping the
    // decorator made one box = one entry, but the probe still ran through whichever view
    // arrived first, and an `elevatedExecutor` view runs every command through `sudo -n`.
    // So `id -u` answers 0 and the profile reads `isRoot: true` / `loginUser: "root"` for a
    // non-root box — then serves that to every later caller of the BASE executor until the
    // TTL expires. Unwrapping had widened the blast radius of that mismeasurement from the
    // elevated view to the whole host. The house rule is elevate the write, never the
    // verify; a profile describes the login we actually have, and elevation is a capability
    // derived from it, not a different machine.
    const profile = parseEnvironmentProbe(await runProbe(key));
    // A refresh that could not MEASURE the box must not overwrite one that did: a
    // `probeError` renders as `supported: false`, so a single slow moment would otherwise
    // turn a host that has been deploying happily for an hour into "Openship cannot
    // provision this machine" halfway through the next deploy. Expiry exists to let a good
    // answer improve, never to let a not-an-answer arrive.
    //
    // `probeError` is narrow on purpose and that is what makes this safe: it means nothing
    // of ours came back at all (timeout, channel torn down). A box that answers with
    // something ELSE — a forced command that appeared since — is a real change and is
    // believed. A transport fault still throws out of `runProbe`: that one means
    // unreachable, and the caller owns it.
    if (profile.probeError && cached) {
      systemDebug("environment", `detect:keep-previous ${profile.probeError}`);
      return cached.profile;
    }
    systemDebug("environment", `detect:done ${JSON.stringify(profile)}`);
    return profile;
  })();

  // Un-poison: a transport blip used to be permanent for the executor's lifetime,
  // because the rejected promise stayed in the cache and every later caller re-awaited
  // the same failure. Only measurements are worth keeping — and the failure that RESOLVES
  // needs the same treatment as the one that rejects, or one slow minute decides how this
  // host is driven for the rest of the process's life: the profile says `serviceManager:
  // "none"`, so `detectSupervisor` picks nohup on a systemd box and the workload silently
  // stops surviving reboots.
  const entry: CachedProfile = { measuredAt: Date.now(), profile: promise };
  const forget = () => {
    if (profileCache.get(key) === entry) profileCache.delete(key);
  };
  profileCache.set(key, entry);
  promise.then((profile) => {
    if (profile.probeError) forget();
  }, forget);

  return promise;
}

/**
 * Seed the cache with a profile measured some other way.
 *
 * Exists for exactly one caller: `environment-local.ts` resolves this machine with
 * `spawnSync`, because the CLI's install preview is synchronous. Publishing that result
 * under the local executor's key means the sync and async paths can't hold different
 * beliefs about the same box — the alternative is two profiles for one host, which is
 * the class of bug this module was rewritten to remove.
 */
export function cacheEnvironment(
  executor: CommandExecutor,
  profile: EnvironmentProfile,
): void {
  profileCache.set(cacheKeyFor(executor), {
    measuredAt: Date.now(),
    profile: Promise.resolve(profile),
  });
}

/**
 * Forget a host's profile, so the next `resolveEnvironment` re-probes it.
 *
 * Deliberately has no caller inside provisioning, and that is a property rather than an
 * omission: nothing Openship installs changes a field this profile carries. It does not
 * install a package manager, an init system or a firewall, so a profile measured before a
 * Docker install is still true after one. The one staleness that DID bite — a probe that
 * timed out being kept as though it were a measurement — is handled at the source in
 * `resolveEnvironment`, because relying on every caller to remember an invalidation is the
 * class of bug this module exists to remove.
 *
 * What remains is the out-of-band case: the operator changed the box under us (enabled ufw
 * by hand, joined a sudo group). {@link ENVIRONMENT_PROFILE_TTL_MS} is the floor there — it
 * bounds how long a change stays invisible without anyone having to notice it happened —
 * and this is the immediate path, called where we already KNOW the target may have moved:
 * `sshManager.invalidate()`, which fires when a server's connection settings change or the
 * row is deleted. Mirrors `invalidateEdgeContainer`.
 */
export function invalidateEnvironment(executor: CommandExecutor): void {
  profileCache.delete(cacheKeyFor(executor));
}
