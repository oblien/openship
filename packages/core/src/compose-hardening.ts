/**
 * Compose `read_only` / `cap_drop` / `security_opt` / `tmpfs` / `user`: the five
 * runtime-hardening controls a container asks for and must not lose on the way in
 * (#749).
 *
 * This is the single authority on what those five accept and how they normalize,
 * imported by the raw Compose parser, the CLI `docker compose config` sync mapper
 * and the Docker runtime. Same shape `compose-namespace.ts` uses, and for the same
 * reason: a second spelling of these rules is how a service ends up stored with a
 * control the runtime then doesn't apply.
 *
 * WHY THESE FIVE, AND NOT `cap_add` / `privileged` / `devices` / `sysctls`
 * -----------------------------------------------------------------------
 * OWASP's Docker Security Cheat Sheet recommends combining exactly these: a
 * non-root `user`, a `read_only` root filesystem with `tmpfs` for the paths that
 * must stay writable, `no-new-privileges` and an AppArmor/SELinux profile via
 * `security_opt`, and `cap_drop`.
 *
 * The line is which way the omission fails. Dropping `cap_add`, `privileged`,
 * `devices` or `sysctls` leaves a container MORE restricted than its file asked
 * for, so reporting-and-continuing is safe. Dropping any of the five here leaves
 * it WEAKER than asked while the deploy reports success: a container the operator
 * believes is running unprivileged on a read-only root, running as root on a
 * writable one. Honoring the first group is a decision about openship's posture;
 * these five are only about preserving the operator's.
 *
 * ROUND-TRIP ONLY
 * ---------------
 * Like `networkMode` / `pidMode` / `entrypoint`, the compose file OWNS these. They
 * are parsed from the file, carried on `advanced`, round-tripped through the API so
 * a read/edit/write of the whole blob isn't rejected, and cleared when the file
 * stops asking (`COMPOSE_OWNED_ADVANCED_KEYS` in @repo/db). They are not authored
 * through the API.
 *
 * WHAT IS DELIBERATELY NOT NORMALIZED, AND HOW THAT WAS DECIDED
 * ------------------------------------------------------------
 * Capability names are kept exactly as written. Measured against Engine 29.2.1:
 * `docker run` normalizes `net_raw` to `CAP_NET_RAW` and sorts the list, but the
 * ENGINE API, the path dockerode and therefore this runtime takes, stores what it
 * is given verbatim, and `net_raw`, `NET_RAW` and `CAP_NET_RAW` all clear the same
 * bit in the container's effective set. Normalizing would only make the inspect
 * readback disagree with the operator's file for no behavioural gain.
 *
 * `security_opt` values are stored as authored, in the file's own spelling and
 * order, with one exception: an entry asking for `unconfined`. Those ask for LESS
 * confinement than Docker's default, which is the direction openship already
 * declines to take a file's word for (`cap_add`, `privileged`, `devices` and
 * `sysctls` are all reported and not applied). So they are reported and not
 * applied either, the container keeps Docker's default profile, and the import is
 * NOT blocked: the rest of the list still lands.
 *
 * THE FALSE / EMPTY FORM IS NOT STORED, AND THAT IS FORCED
 * -------------------------------------------------------
 * `read_only: false` and `cap_drop: []` name a control while requesting exactly the
 * behaviour the container already has. More decisively: `docker compose config`
 * DROPS both keys from its normalized output, so the CLI sync door cannot see them
 * at all. Storing them on the raw-YAML door would make the two doors produce
 * different `advanced` for the same file. Clearing a previously-set control is not
 * lost by this: it happens through the key going absent, which is exactly what a
 * compose-owned key means.
 *
 * Pure string/array logic, no dependencies, same as compose-namespace.ts.
 */

/** The five compose keys this module owns, spelled as the file spells them. */
export type ComposeHardeningField = "read_only" | "cap_drop" | "security_opt" | "tmpfs" | "user";

/** The normalized form of all five, as stored on `advanced`. */
export type ComposeHardening = {
  /** `read_only: true` only. See the header for why `false` is never stored. */
  readOnly?: boolean;
  /** `cap_drop`, in the file's order and the file's spelling. */
  capDrop?: string[];
  /** `security_opt`, verbatim. */
  securityOpt?: string[];
  /** `tmpfs` mount specs (`"/run"` or `"/run:size=64m,mode=1777"`), file order. */
  tmpfs?: string[];
  /** `user`: `"<user>"` or `"<user>:<group>"`, name or numeric id. */
  user?: string;
};

/**
 * The five keys, as `advanced` spells them.
 *
 * One list, so "which keys are the hardening keys" is answered in exactly one
 * place: a runtime declaring it cannot honor them, the clearing sweep in
 * @repo/db, and {@link pickHardening} all read from here rather than each
 * repeating five strings that can fall out of step one at a time.
 */
export const COMPOSE_HARDENING_KEYS = [
  "readOnly",
  "capDrop",
  "securityOpt",
  "tmpfs",
  "user",
] as const satisfies readonly (keyof ComposeHardening)[];

/** Just the hardening keys off a wider `advanced` blob, or undefined if none. */
export function pickHardening(
  advanced: ComposeHardening | null | undefined,
): ComposeHardening | undefined {
  if (!advanced) return undefined;
  const out: ComposeHardening = {};
  for (const key of COMPOSE_HARDENING_KEYS) {
    const value = advanced[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Why one value was not stored. Operator-facing: it names the field and the value. */
export type ComposeHardeningIssue = {
  field: ComposeHardeningField;
  reason: string;
  /**
   * Whether the import must refuse the file.
   *
   * True for a value openship cannot read, because continuing would deploy a
   * container the file did not describe. False for a value it read and declined
   * to apply, where the file is understood, the rest of its hardening stands and
   * the operator only needs telling. Set explicitly on every issue: a consumer
   * reading an absent flag as false would drop a real refusal on the floor.
   */
  blocking: boolean;
};

export type ComposeHardeningParse = {
  /** Only the keys the file actually asked for. Empty when it asked for none. */
  hardening: ComposeHardening;
  /** Values that were not stored. The importer must refuse on any BLOCKING one. */
  issues: ComposeHardeningIssue[];
};

/**
 * A capability name: `ALL`, `NET_RAW`, `CAP_NET_RAW`, `net_raw`. Deliberately
 * accepts every case and both prefix forms, because the Engine does (measured).
 * This rejects punctuation, spaces and empty entries, not spelling choices.
 */
const CAPABILITY = /^(CAP_)?[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A `user` value: `name`, `1000`, `name:group`, `1000:1000`. At most one colon,
 * and no whitespace or control characters. Docker resolves the rest against the
 * image's own passwd/group at start, and it is the only thing that can.
 */
const USER_SPEC = /^[^\s:\u0000-\u001F\u007F]+(:[^\s:\u0000-\u001F\u007F]+)?$/;

/** Anything that would make a tmpfs target or its options unparseable. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Compose's own boolean spellings, so both import doors read one file the same
 * way.
 *
 * compose-go `loader/interpolate.go`, `toBoolean`, lines 103 to 118: `true` and
 * `false` case-insensitively, plus the YAML 1.1 forms `y`/`yes`/`on` and
 * `n`/`no`/`off`, which it still accepts while logging that they are not YAML
 * 1.2. Anything else, `1` and `0` included, makes compose refuse the file
 * outright. Measured against Compose 2.40.3, every form in both sets.
 */
const COMPOSE_TRUE = new Set(["true", "y", "yes", "on"]);
const COMPOSE_FALSE = new Set(["false", "n", "no", "off"]);

/** The bare `security_opt` forms the daemon takes whole, before any separator. */
const SECURITY_OPT_BARE = new Set(["no-new-privileges", "writable-cgroups", "disable"]);

/**
 * Split one `security_opt` entry the way the daemon splits it.
 *
 * moby `daemon/daemon_unix.go`, `parseSecurityOpt`, lines 203 to 261 at tag
 * `docker-v29.1.3`. The bare forms above are taken whole (lines 210 to 222).
 * Otherwise the entry is cut at the FIRST `=` when it contains one, and only
 * failing that at the first `:`, the older separator the daemon still honors
 * while warning "Security options with `:` as a separator are deprecated" (lines
 * 224 to 230). Cutting at `=` first is what makes `label=user:USER` and
 * `label:user:USER` both parse to the same key and value. An entry with neither
 * separator and no bare form is the one shape the daemon itself errors on.
 *
 * This is shape only. Which KEYS exist is Docker's to decide and changes between
 * releases, so an unknown key is stored and left to the daemon rather than
 * refused here against a list that would go stale.
 */
function splitSecurityOpt(opt: string): { key: string; value: string } | undefined {
  if (SECURITY_OPT_BARE.has(opt)) return { key: opt, value: "" };
  const eq = opt.indexOf("=");
  if (eq !== -1) return { key: opt.slice(0, eq), value: opt.slice(eq + 1) };
  const colon = opt.indexOf(":");
  if (colon !== -1) return { key: opt.slice(0, colon), value: opt.slice(colon + 1) };
  return undefined;
}

/** What the container keeps when an `unconfined` entry is not applied. */
function defaultConfinement(key: string): string {
  if (key === "seccomp") return "Docker's default seccomp profile";
  if (key === "apparmor") return "Docker's default AppArmor profile";
  if (key === "systempaths") return "Docker's default masked and read-only system paths";
  return "Docker's default confinement";
}

/** Whitespace-only or absent means the key wasn't really set. */
function text(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value || undefined;
  }
  // A raw uploaded YAML can carry `user: 1000`, which is a valid YAML integer.
  // `docker compose config` refuses it ("user must be a string"), so only the
  // API's own file door can produce one. Coerce rather than lose the request.
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * Read a compose list-or-scalar key into a list of trimmed strings.
 *
 * `tmpfs: /run` and `tmpfs: [/run]` mean the same thing, and `docker compose
 * config` normalizes the first into the second (measured), so the raw-YAML door
 * has to accept both for the two doors to agree.
 */
function stringList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    const value = text(item);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** The tmpfs TARGET: everything before the first colon (`/run:size=64m` to `/run`). */
export function tmpfsTarget(spec: string): string {
  const colon = spec.indexOf(":");
  return colon === -1 ? spec : spec.slice(0, colon);
}

/** The tmpfs OPTIONS: everything after the first colon, `""` when there are none. */
function tmpfsOptions(spec: string): string {
  const colon = spec.indexOf(":");
  return colon === -1 ? "" : spec.slice(colon + 1);
}

/**
 * Parse the five hardening keys off one compose service.
 *
 * Returns issues rather than throwing, for the reason `parseComposeNamespace`
 * does: every caller is INSPECTING a file the operator hasn't had a chance to fix
 * yet (import scan, CLI sync), and only unusable YAML throws.
 *
 * `interpolate` lets the raw-YAML door expand `${VAR}` before validation; the CLI
 * door passes nothing because `docker compose config` already expanded everything.
 */
export function parseComposeHardening(
  svc: Record<string, unknown>,
  interpolate: (value: string) => string = (value) => value,
): ComposeHardeningParse {
  const hardening: ComposeHardening = {};
  const issues: ComposeHardeningIssue[] = [];
  const expand = (value: string) => interpolate(value);

  // read_only ----------------------------------------------------------------
  // Only `true` is stored. Interpolated BEFORE the check, and read through
  // compose's own boolean spellings, because both are what the CLI door already
  // gets for free: `docker compose config` resolves `read_only: ${RO}` and casts
  // `"true"` to a real boolean, so a raw-YAML door testing for a literal boolean
  // refused files the other door imported, in a module whose whole purpose is
  // that the two agree. A value neither door can read is a typo worth naming:
  // treating it as false would leave the root filesystem writable on a file that
  // asked for the opposite.
  const rawReadOnly = svc.read_only;
  if (rawReadOnly !== undefined && rawReadOnly !== null) {
    const scalar = typeof rawReadOnly === "string" ? expand(rawReadOnly).trim() : rawReadOnly;
    const spelling = typeof scalar === "string" ? scalar.toLowerCase() : undefined;
    if (scalar === true || (spelling !== undefined && COMPOSE_TRUE.has(spelling))) {
      hardening.readOnly = true;
    } else if (scalar === false || (spelling !== undefined && COMPOSE_FALSE.has(spelling))) {
      // Asks for exactly the default, so nothing is stored. See the header.
    } else {
      issues.push({
        field: "read_only",
        reason:
          `read_only: ${JSON.stringify(scalar)} is not a boolean. Compose accepts true or ` +
          `false (and the YAML 1.1 spellings yes/no, on/off, y/n).`,
        blocking: true,
      });
    }
  }

  // cap_drop -----------------------------------------------------------------
  const capDrop = stringList(svc.cap_drop);
  if (capDrop !== undefined) {
    const kept: string[] = [];
    // Deduped case- and prefix-insensitively (`NET_RAW` and `cap_net_raw` are one
    // capability) while KEEPING the first spelling the file used: dropping twice
    // is dropping once, so a duplicate is noise rather than a second request.
    const seen = new Set<string>();
    for (const rawName of capDrop) {
      const name = expand(rawName).trim();
      if (!name) continue;
      if (!CAPABILITY.test(name)) {
        issues.push({
          field: "cap_drop",
          reason:
            `cap_drop: "${name}" is not a capability name. Openship accepts ALL or a ` +
            `capability with or without its CAP_ prefix (e.g. NET_RAW, CAP_NET_RAW).`,
          blocking: true,
        });
        continue;
      }
      const key = name.toUpperCase().replace(/^CAP_/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(name);
    }
    if (kept.length > 0) hardening.capDrop = kept;
  }

  // security_opt -------------------------------------------------------------
  const securityOpt = stringList(svc.security_opt);
  if (securityOpt !== undefined) {
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const rawOpt of securityOpt) {
      const opt = expand(rawOpt).trim();
      if (!opt) continue;
      if (CONTROL_CHARS.test(opt)) {
        issues.push({
          field: "security_opt",
          reason: `security_opt: ${JSON.stringify(opt)} contains a control character.`,
          blocking: true,
        });
        continue;
      }
      // An entry the daemon cannot split is a typo it would refuse at create,
      // after the currently-serving container was already removed.
      const split = splitSecurityOpt(opt);
      if (!split) {
        issues.push({
          field: "security_opt",
          reason:
            `security_opt: "${opt}" is not a recognized option. Docker takes key=value, ` +
            `or the older key:value (e.g. no-new-privileges=true, apparmor=<profile>, ` +
            `label=user:USER), or a bare no-new-privileges.`,
          blocking: true,
        });
        continue;
      }
      // `seccomp=unconfined` and its neighbours ask for LESS confinement than the
      // daemon's default, which is the one direction this module does not take
      // the file's word for. Reported and not applied, exactly as `cap_add` is,
      // and NOT blocking: the file is understood and the rest of its list stands.
      if (split.value === "unconfined") {
        issues.push({
          field: "security_opt",
          reason:
            `security_opt: "${opt}" is not applied; the container keeps ` +
            `${defaultConfinement(split.key)}.`,
          blocking: false,
        });
        continue;
      }
      if (seen.has(opt)) continue;
      seen.add(opt);
      kept.push(opt);
    }
    if (kept.length > 0) hardening.securityOpt = kept;
  }

  // tmpfs --------------------------------------------------------------------
  const tmpfs = stringList(svc.tmpfs);
  if (tmpfs !== undefined) {
    const kept: string[] = [];
    const targets = new Set<string>();
    for (const rawSpec of tmpfs) {
      const spec = expand(rawSpec).trim();
      if (!spec) continue;
      if (CONTROL_CHARS.test(spec)) {
        issues.push({
          field: "tmpfs",
          reason: `tmpfs: ${JSON.stringify(spec)} contains a control character.`,
          blocking: true,
        });
        continue;
      }
      const target = tmpfsTarget(spec);
      if (!target.startsWith("/")) {
        issues.push({
          field: "tmpfs",
          reason: `tmpfs: "${spec}" must mount an absolute path (e.g. /run, /tmp:size=64m).`,
          blocking: true,
        });
        continue;
      }
      // Two specs for one target cannot both apply: `HostConfig.Tmpfs` is a MAP
      // keyed by path, so the second would silently win and the first would be
      // gone, taking a size cap or a `noexec` the file asked for with it. Name
      // it instead.
      if (targets.has(target)) {
        issues.push({
          field: "tmpfs",
          reason:
            `tmpfs: ${target} is mounted twice ("${spec}" and an earlier entry). ` +
            `Docker keys tmpfs mounts by path, so only one set of options can apply. ` +
            `Merge them into a single entry.`,
          blocking: true,
        });
        continue;
      }
      targets.add(target);
      kept.push(spec);
    }
    if (kept.length > 0) hardening.tmpfs = kept;
  }

  // user ---------------------------------------------------------------------
  const rawUser = text(svc.user);
  if (rawUser !== undefined) {
    const user = expand(rawUser).trim();
    if (user) {
      if (USER_SPEC.test(user)) {
        hardening.user = user;
      } else {
        issues.push({
          field: "user",
          reason:
            `user: "${user}" is not a valid user spec. Openship accepts <user> or ` +
            `<user>:<group>, each a name or a numeric id.`,
          blocking: true,
        });
      }
    }
  }

  return { hardening, issues };
}

/**
 * The stored hardening, as the Docker Engine's create payload spells it.
 *
 * Split into the two places Docker puts them (`User` is top-level container
 * config, the other four are `HostConfig`) so the runtime spreads each into the
 * right block. Returns only the keys that were actually requested: an absent key
 * has to STAY absent so Docker keeps its own default, the same conditional-spread
 * contract `toStopConfig` and the `Entrypoint` handling already follow.
 *
 * Verified against Engine 29.2.1 with all five set at once: the container came up
 * as uid 1000 with an empty effective capability set, `NoNewPrivs: 1`, a
 * read-only root that refused a write, and a writable size-capped `/run`.
 */
export function dockerHardening(hardening: ComposeHardening | undefined | null): {
  config: { User?: string };
  hostConfig: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    Tmpfs?: Record<string, string>;
  };
} {
  const config: { User?: string } = {};
  const hostConfig: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    Tmpfs?: Record<string, string>;
  } = {};
  if (!hardening) return { config, hostConfig };

  if (hardening.user) config.User = hardening.user;
  if (hardening.readOnly) hostConfig.ReadonlyRootfs = true;
  if (hardening.capDrop?.length) hostConfig.CapDrop = [...hardening.capDrop];
  if (hardening.securityOpt?.length) hostConfig.SecurityOpt = [...hardening.securityOpt];
  if (hardening.tmpfs?.length) {
    // `/run:size=64m,mode=1777` becomes `{ "/run": "size=64m,mode=1777" }`; a
    // bare `/run` becomes `{ "/run": "" }`, which is how Docker spells "default
    // options".
    const mounts: Record<string, string> = {};
    for (const spec of hardening.tmpfs) mounts[tmpfsTarget(spec)] = tmpfsOptions(spec);
    hostConfig.Tmpfs = mounts;
  }

  return { config, hostConfig };
}

/**
 * The inverse of {@link dockerHardening}: what a LIVE container is actually
 * confined by, read off an inspect and expressed in the same stored shape.
 *
 * Here rather than in the runtime so the two directions cannot drift, which is
 * the whole reason this module exists. Adoption needs it for the same reason it
 * needs `inspectResourceLimits`: a container started by hand has no compose
 * declaration to read, so the running container is the only source of truth about
 * how confined it is, and reading it as unconfined is the silent downgrade.
 *
 * Returns `undefined` when the container asked for none of the five, so an
 * unhardened container adds no key and the compose file's answer stands.
 * `Tmpfs`'s map is turned back into the `path` / `path:options` specs the file
 * writes, sorted by path because a JSON object's key order is not meaningful and
 * an unstable one would read as drift on every inspect.
 */
export function inspectHardening(data: {
  Config?: { User?: string | null } | null;
  HostConfig?: {
    ReadonlyRootfs?: boolean | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    Tmpfs?: Record<string, string> | null;
  } | null;
}): ComposeHardening | undefined {
  const out: ComposeHardening = {};
  const user = data.Config?.User?.trim();
  if (user) out.user = user;

  const host = data.HostConfig;
  if (host?.ReadonlyRootfs) out.readOnly = true;
  if (host?.CapDrop?.length) out.capDrop = [...host.CapDrop];
  if (host?.SecurityOpt?.length) out.securityOpt = [...host.SecurityOpt];
  const mounts = host?.Tmpfs;
  if (mounts && Object.keys(mounts).length > 0) {
    out.tmpfs = Object.keys(mounts)
      .sort()
      .map((path) => (mounts[path] ? `${path}:${mounts[path]}` : path));
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
