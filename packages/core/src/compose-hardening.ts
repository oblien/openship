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
 * `security_opt` values are passed through as authored, `unconfined` forms
 * included. Rewriting or filtering an operator's list is the same silent
 * modification this module exists to end, and half-honoring one is worse than
 * either extreme: the file says `security_opt` is supported and the container gets
 * a different list than it wrote.
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
export type ComposeHardeningField =
  | "read_only"
  | "cap_drop"
  | "security_opt"
  | "tmpfs"
  | "user";

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

/** Why one value was refused. Operator-facing: it names the field and the value. */
export type ComposeHardeningIssue = {
  field: ComposeHardeningField;
  reason: string;
};

export type ComposeHardeningParse = {
  /** Only the keys the file actually asked for. Empty when it asked for none. */
  hardening: ComposeHardening;
  /** Values that could not be honored. Non-empty means the importer must refuse. */
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
  // Only `true` is stored. A non-boolean is a typo worth naming: `read_only:
  // "true"` is a STRING in YAML, and silently treating it as false would leave
  // the root filesystem writable on a file that asked for the opposite.
  const rawReadOnly = svc.read_only;
  if (rawReadOnly !== undefined && rawReadOnly !== null) {
    if (typeof rawReadOnly === "boolean") {
      if (rawReadOnly) hardening.readOnly = true;
    } else {
      issues.push({
        field: "read_only",
        reason: `read_only must be true or false, got ${JSON.stringify(rawReadOnly)}.`,
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
        });
        continue;
      }
      // Every form Docker takes is `key:value` (`no-new-privileges:true`,
      // `apparmor:profile`, `seccomp:unconfined`, `label:user:USER`) or the bare
      // `no-new-privileges`. Anything else is a typo Docker would refuse at
      // create, after the currently-serving container was already removed.
      if (!opt.includes(":") && opt !== "no-new-privileges") {
        issues.push({
          field: "security_opt",
          reason:
            `security_opt: "${opt}" is not a recognized option. Docker expects ` +
            `key:value (e.g. no-new-privileges:true, seccomp:unconfined, ` +
            `apparmor:<profile>, label:<key>:<value>).`,
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
        });
        continue;
      }
      const target = tmpfsTarget(spec);
      if (!target.startsWith("/")) {
        issues.push({
          field: "tmpfs",
          reason: `tmpfs: "${spec}" must mount an absolute path (e.g. /run, /tmp:size=64m).`,
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
