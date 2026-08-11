import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankComments as code } from "./source-scan.fixtures";

/**
 * One place authors per-host commands. This is the test that keeps it one place.
 *
 * The bug this whole layer exists to fix was not a wrong command — it was FIVE tables that
 * each knew a little about apt/dnf/yum/apk, disagreed about which of them counted, and
 * silently no-op'd on a host none of them listed (`amzn`). No type can catch a sixth table
 * being written, because a new `Record<string, string>` in a new file compiles perfectly.
 * A source-level guard can, and this one does — the same technique as
 * `apps/api/test/lib/host-executor-guard.test.ts`.
 *
 * The rule is about AUTHORING, not about mentioning. A file may say `ufw` in prose all it
 * likes; what it may not do is decide, locally, what to run on a host. Comments are
 * stripped before matching for exactly that reason.
 *
 * Scope is every source root that can reach a host — including `packages/core`, whose
 * renderers print commands for an operator to paste, and `apps/dashboard`, which must only
 * ever display what the API computed. `apps/web` is deliberately absent: it is docs, and
 * docs quote commands for a living.
 */
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

const ROOTS = [
  "packages/adapters/src",
  "packages/core/src",
  "apps/api/src",
  "apps/cli/src",
  "apps/dashboard/src",
] as const;

const OPS = "packages/adapters/src/system/environment-ops.ts";
const DETECTOR = "packages/adapters/src/system/environment.ts";

/** Repo-relative paths of every non-test source file under {@link ROOTS}. */
function sources(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const entry of readdirSync(`${REPO}${root}`, { recursive: true, encoding: "utf8" })) {
      const rel = `${root}/${entry.split("\\").join("/")}`;
      if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) continue;
      if (/\.(test|spec|fixtures)\.tsx?$/.test(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

const cache = new Map<string, string>();
const read = (rel: string) => {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  const src = code(readFileSync(`${REPO}${rel}`, "utf8"));
  cache.set(rel, src);
  return src;
};

/** `rel:line` of the first match, or `null` — the line number is why `code()` blanks. */
function locate(rel: string, pattern: RegExp): string | null {
  const src = read(rel);
  const at = src.search(pattern);
  return at === -1 ? null : `${rel}:${src.slice(0, at).split("\n").length}`;
}

/** Prose SoT: the paste-me forms an operator reads, family-total, rendered by the
 *  dashboard — which is why they cannot come from `envOps`, since core must not import
 *  the adapters (see `host-channel.ts`'s own note). */
const PROSE = "packages/core/src/host-channel.ts";

interface OwnershipRule {
  /** What the pattern finds, phrased for the failure message. */
  readonly what: string;
  /**
   * `[ \t]` and never `\s`: a command lives on one line, and `\s` would match the newline
   * after `PM=apt` in the detector script and report the shell as an install. `[\w$-]`
   * rather than `[a-z]` because most of these are template literals, so the character
   * after the verb is usually `${`.
   */
  readonly pattern: RegExp;
  readonly owners: readonly string[];
  readonly why: string;
}

const RULES: readonly OwnershipRule[] = [
  {
    what: "a package manager",
    // A real subcommand, not just the name: `apt-get install -y` is authoring, "quiet
    // while apt works" in a progress notice is not, and the refusal that lists
    // "apt-get, dnf, yum or apk" as what it looked for is the opposite of authoring.
    pattern:
      /\b(?:apt|apt-get|apt-cache|dpkg|dnf|yum|apk|zypper|pacman|brew)[ \t]+(?:-{1,2}[\w-]+[ \t]+)*(?:install|remove|purge|uninstall|autoremove|add|del|delete|update|upgrade|policy|list|search|info)\b/,
    owners: [
      OPS,
      PROSE,
      // Not the host: a pinned alpine helper CONTAINER, whose package manager is a fact
      // about the image we chose and not about the box it runs on. Narrowed below.
      "packages/adapters/src/backup/executors/docker.ts",
    ],
    why:
      "A per-package-manager table outside environment-ops.ts is how this bug happened — " +
      "five of them, none of which listed `amzn`. Route the verb through " +
      "`envOps(profile).pkgInstall/pkgRemove/pkgAvailableVersion` and keep only the " +
      "package NAME locally.",
  },
  {
    what: "a firewall",
    pattern: /\b(?:ufw|firewall-cmd|nft|iptables|ip6tables)[ \t]+[\w$-]/,
    owners: [
      // The rules themselves, so the CLI, the API and the dashboard render one syntax:
      // `envOps` runs these steps, nobody re-spells them.
      "packages/core/src/host-firewall.ts",
      PROSE,
      // Looking, never touching — asserted separately below.
      DETECTOR,
    ],
    why:
      "Firewall syntax is authored once in @repo/core/host-firewall.ts. A second copy is " +
      "how the CLI came to refuse a rule the API applied to the same box.",
  },
  {
    what: "an OpenRC service verb",
    /**
     * The tripwire for a second per-init table, and the reason a bare `systemctl` is NOT
     * on this list. A file that only speaks systemd is either the SystemdSupervisor or
     * code acting on a unit it *discovered* as a systemd unit — true by construction, with
     * its own non-systemd path (a PID, a container, nothing). But you cannot write an
     * init-system BRANCH without naming the other dialect, and that lands here.
     */
    pattern: /\b(?:rc-service|rc-update)[ \t]+[\w$-]/,
    owners: [OPS, PROSE],
    why:
      "Naming OpenRC outside environment-ops.ts means a second init-system branch. " +
      "`envOps(profile).service` already answers for systemd, OpenRC, launchd and none — " +
      "including that OpenRC needs two steps where systemd takes `--now`.",
  },
  {
    what: "boot persistence for a service",
    // `enable`/`rc-update add` and not `disable`: making a service come back after a
    // reboot is a policy statement about the host, while disabling a foreign proxy unit
    // that a scan just handed us is an action on a specific discovered unit.
    pattern: /\b(?:systemctl|rc-update)[ \t]+(?:-{1,2}[\w-]+[ \t]+)*(?:enable|add)\b/,
    owners: [
      OPS,
      PROSE,
      // Selected only when systemd is the running init (`supervisor/detect.ts`), and it
      // enables the unit files it wrote itself.
      "packages/adapters/src/runtime/supervisor/systemd.ts",
      // Re-enables a unit IT disabled during an edge takeover, on rollback. The unit came
      // from a systemd scan, so systemd is a fact about that unit and not an assumption.
      "packages/adapters/src/system/proxy/takeover-journal.ts",
      // Installs Openship's OWN service on the machine the CLI runs on: a user-level unit
      // plus `loginctl enable-linger`, which is not a shape `envOps` speaks. It already
      // takes the systemd/launchd decision from the resolver rather than probing.
      "apps/cli/src/lib/service.ts",
    ],
    why:
      "Whether a service survives a reboot — and what command says so — is per-init " +
      "policy. Ask `envOps(profile).serviceEnableStart()`.",
  },
  {
    what: "the get.docker.com bootstrap script",
    pattern: /get\.docker\.com/,
    owners: [OPS],
    why:
      "That script reads os-release `ID` verbatim and exits 1 on anything it doesn't " +
      "list — `amzn` and `alpine` included. Whether it may run at all is a decision " +
      "`dockerInstall()` makes from the profile.",
  },
  {
    what: "the privilege escape hatch",
    /**
     * `RootChecked` is only worth its weight while the brand is hard to obtain. One
     * ungated `rootChecked(…)` in a routing path restores the exact bug the type exists
     * to prevent — an unelevated edge executor, a green deploy, and no error anywhere —
     * and it restores it while looking like the code that fixed it.
     *
     * Two owners, and each has a reason no gate can express: the gate itself, and the
     * local compose edge, whose executor runs inside the EDGE container so probing
     * through it would measure the wrong machine.
     */
    pattern: /\brootChecked\(/,
    owners: [
      "packages/adapters/src/system/privilege.ts",
      "packages/adapters/src/system/proxy/ensure-container-edge.ts",
    ],
    why:
      "Obtain a RootChecked executor from `privilegedExecutor` (work that may refuse) or " +
      "`rootOrDegrade` (routing and TLS, which must never fail a deploy). Reach for " +
      "`rootChecked` only where no login exists to elevate, and add the file here.",
  },
];

function rule(what: string): OwnershipRule {
  const found = RULES.find((r) => r.what === what);
  if (!found) throw new Error(`no rule named ${what}`);
  return found;
}

describe("the comment stripper", () => {
  /** The implementation this guard shipped with, kept as the thing being disproved. */
  const naive = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const PKG = rule("a package manager").pattern;

  it("sees an install that a glob's shadow hid from the naive one", () => {
    // `/*.conf` is a shell glob in a template literal. To the naive stripper it opens a
    // comment, and the next close marker is three lines down — so the install between
    // them was never scanned. This shape is everywhere in the proxy code.
    const src = [
      "const include = `include ${sitesDir}/*.conf;`;",
      "await exec(`apt-get install -y ${pkg}`);",
      "/** Whatever this JSDoc says, its close is what ended the shadow. */",
      "",
    ].join("\n");

    expect(naive(src), "fixture no longer reproduces the blind spot").not.toMatch(PKG);
    expect(code(src)).toMatch(PKG);
    const at = code(src).search(PKG);
    expect(code(src).slice(0, at).split("\n")).toHaveLength(2);
  });

  it("reads a regex literal as a value, not as a comment", () => {
    const src = "if (/https:\\/\\//.test(u)) await exec(`apk add curl`);\n";
    expect(code(src)).toMatch(PKG);
  });

  it("reads a regex after an arrow as a value", () => {
    // The position the char-class incident actually occurs in — `.filter((k) => /…/)` —
    // and the one the length invariant cannot catch, because blanking keeps the length
    // whether it blanked a comment or ate the next twenty lines of commands.
    const src = [
      "const isGlob = (s: string) => /^[\\w./*?-]+$/.test(s);",
      "await exec(`apt-get install -y ${pkg}`);",
      "/** The close of this JSDoc is what ended the shadow. */",
      "",
    ].join("\n");
    expect(code(src)).toMatch(PKG);
  });

  it("keeps every newline a comment spanned", () => {
    const src = "a();\n/* one\n   two\n*/\nb();\n";
    const line = (s: string) => s.slice(0, s.indexOf("b()")).split("\n").length;
    expect(line(code(src))).toBe(5);
    expect(line(naive(src)), "fixture no longer reproduces the line shift").toBeLessThan(5);
  });

  it("still refuses to match an explanation of a command", () => {
    const src = "// paste `apt-get install -y curl`\n/* or `dnf install curl` */\nnoop();\n";
    expect(code(src)).not.toMatch(PKG);
    expect(code(src)).toHaveLength(src.length);
  });

  it("leaves a url alone", () => {
    expect(code('const u = "https://example.com/x"; // note\n')).toContain("https://example.com/x");
  });
});

describe("per-host commands have exactly one author", () => {
  const files = sources();

  it("scans the source roots it claims to", () => {
    // A guard that finds no files passes every rule. This is the assertion that a moved
    // directory or a broken glob shows up as a failure instead of a green run.
    expect(files.length).toBeGreaterThan(800);
    for (const root of ROOTS) {
      expect(
        files.some((f) => f.startsWith(`${root}/`)),
        `no sources found under ${root}`,
      ).toBe(true);
    }
  });

  it("blanks comments without moving a single character", () => {
    // The invariant the whole guard rests on: `code()` may only replace comment text with
    // spaces. Any file it shortens is a file whose code it ate, and eaten code is a
    // violation this guard would report as green.
    for (const rel of files) {
      const src = readFileSync(`${REPO}${rel}`, "utf8");
      expect(read(rel), `${rel}: code() changed the file's length`).toHaveLength(src.length);
    }
  });

  for (const rule of RULES) {
    it(`only its owners name ${rule.what}`, () => {
      const offenders = files
        .filter((f) => !rule.owners.includes(f))
        .map((f) => locate(f, rule.pattern))
        .filter((v) => v !== null);
      expect(offenders, rule.why).toEqual([]);
    });

    it(`every file listed as an owner of ${rule.what} still is one`, () => {
      // A stale allowance is worse than none: it reads as "this is permitted here" long
      // after the code moved, and the next author takes it as precedent.
      const stale = rule.owners.filter((f) => !rule.pattern.test(read(f)));
      expect(stale, "listed as an owner but no longer matches — drop it").toEqual([]);
    });
  }
});

describe("the detector looks and never touches", () => {
  /**
   * `environment.ts` is allowed to name every package manager and firewall on the box
   * because naming them IS the detection. What it must never do is act, and the distance
   * between `command -v ufw` and `ufw allow` is one word.
   */
  const MUTATION =
    /\b(?:apt-get|apt|dnf|yum|apk|zypper|pacman)[ \t]+(?:install|add|update|upgrade|remove|del|purge)\b|\bufw[ \t]+(?:allow|deny|delete|enable|disable)\b|\bfirewall-cmd[ \t]+--(?:permanent|add|remove|reload)|\bnft[ \t]+(?:add|delete|flush)\b|\biptables[ \t]+-[IADF]\b|\brc-update[ \t]+add\b|\b(?:systemctl|rc-service)[ \t]+\S*[ \t]*(?:enable|disable|start|stop|restart)\b/;

  it("runs no command that changes the host", () => {
    expect(read(DETECTOR)).not.toMatch(MUTATION);
  });

  it("still probes for the managers it reports", () => {
    // The counterpart: a detector that stopped looking would trivially satisfy the test
    // above. `FW=unknown` for a box that plainly runs firewalld is the failure this pins.
    const src = read(DETECTOR);
    for (const probe of [
      "command -v apt-get",
      "command -v apk",
      "ufw status",
      "firewall-cmd --state",
    ]) {
      expect(src, `detector no longer probes with \`${probe}\``).toContain(probe);
    }
  });
});

describe("the container helper's package manager is the image's, not the host's", () => {
  /**
   * The one exception in the package-manager rule, kept narrow. `apk add --no-cache zstd`
   * runs inside the alpine image the backup executor pins, where the package manager is a
   * property of the image we chose. Anything else in that file would be a host command
   * wearing an exception, so the shape is asserted rather than the file trusted.
   */
  const HELPER = "packages/adapters/src/backup/executors/docker.ts";

  it("only ever runs `apk add --no-cache` there", () => {
    const matches = read(HELPER).match(/\b(?:apt|apt-get|dnf|yum|apk|zypper|pacman)[ \t]+[a-z-]+/g);
    expect(matches?.length).toBeGreaterThan(0);
    for (const match of matches ?? []) expect(match).toBe("apk add");
  });
});
