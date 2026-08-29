import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMailRunCommand,
  ensureContainerMail,
  resolveMailImage,
  setDefaultMailImage,
} from "./ensure-container-mail";
import { setManagedImagesFromSource } from "../managed-image";
import { MAIL_HOST_STATE_DIR } from "../../infra/mail-container";

afterEach(() => {
  setDefaultMailImage(undefined);
  setManagedImagesFromSource("mail", false);
});

/**
 * The one container-state probe every path here goes through (`containerState`):
 * run state AND created-from image in a single `docker inspect`, tab-separated.
 * Stubs match on the template so a change to the probe shape fails loudly instead
 * of silently reading as "no container" (which is how these stubs first drifted).
 */
const STATE_PROBE = "{{.State.Running}}";
const stateLine = (image: string, running = true) => `${running}\t${image}\n`;

describe("buildMailRunCommand", () => {
  it("runs host-networked with NET_ADMIN, restart, env-file, and the load-bearing mounts", () => {
    const cmd = buildMailRunCommand("openship-mail", "ghcr.io/x/openship-mail:1");
    expect(cmd).toContain("--network host");
    expect(cmd).toContain("--cap-add NET_ADMIN");
    expect(cmd).toContain("--restart unless-stopped");
    expect(cmd).toContain("--env-file");
    // The Postfix queue must be a bind mount or a recreate drops in-flight mail.
    expect(cmd).toContain("/var/spool/postfix");
    // The cert store is shared with the edge and mounted read-only.
    expect(cmd).toContain("/etc/letsencrypt:ro,z");
    // Image is the final, shell-quoted token.
    expect(cmd.endsWith("'ghcr.io/x/openship-mail:1'")).toBe(true);
  });
});

describe("resolveMailImage", () => {
  it("prefers an explicit ref, else the injected default", () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    expect(resolveMailImage("explicit:1")).toBe("explicit:1");
    expect(resolveMailImage()).toBe("ghcr.io/x/openship-mail:pinned");
  });
});

describe("ensureContainerMail idempotency", () => {
  it("returns updated:false without pulling when already on the pinned image", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const streamExec = vi.fn(async () => ({ code: 0, output: "" }));
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes(STATE_PROBE)) return stateLine("ghcr.io/x/openship-mail:pinned");
      return "";
    });
    const executor = { exec, streamExec } as never;

    const res = await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(res.updated).toBe(false);
    expect(res.image).toBe("ghcr.io/x/openship-mail:pinned");
    // No pull and no docker run — the running container already matches.
    expect(streamExec).not.toHaveBeenCalled();
  });
});

// A /proc/net/tcp dump with LISTEN (state 0A) sockets for the DB (5432 = 0x1538),
// SMTP (25 = 0x19) and IMAPS (993 = 0x3E1) ports, so waitForPortListening resolves
// on the first poll and the bring-up doesn't spin until its (long) deadline.
const PROC_LISTENING = [
  "  sl  local_address rem_address   st ...",
  "  0: 00000000:1538 00000000:0000 0A 00000000:00000000",
  "  1: 00000000:0019 00000000:0000 0A 00000000:00000000",
  "  2: 00000000:03E1 00000000:0000 0A 00000000:00000000",
].join("\n");

/**
 * A first-boot executor: no container running, docker available, ports reported
 * listening, and the image-presence probe reports whatever `imagePresent` says.
 * `streamExec` and the writes succeed so the bring-up runs end to end.
 */
function firstBootExecutor(opts: { imagePresent: boolean }) {
  const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
  const exec = vi.fn(async (cmd: string) => {
    // No engine on the box yet — the state probe finds nothing.
    if (cmd.includes(STATE_PROBE)) return "";
    // Docker is available.
    if (cmd.includes("docker version")) return "27.0.0\n";
    // Image presence probe (docker image inspect -f '{{.Id}}').
    if (cmd.includes("docker image inspect")) return opts.imagePresent ? "sha256:abc\n" : "";
    // Port-listening probe reads /proc/net/tcp.
    if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
    return "";
  });
  const writeFile = vi.fn(async () => {});
  return { executor: { exec, streamExec, writeFile } as never, exec, streamExec };
}

// Create-path image acquisition: pull only when the image ISN'T already on the box.
// In dev, `deliverManagedImage` builds the content-derived `…-dev.<hash>` engine tag
// on the control plane and ships it here first, so bring-up finds it present and
// skips the pull (an unpublished tag — a pull would 404). In prod the tag is absent,
// so it pulls `:APP_VERSION`.
describe("ensureContainerMail image acquisition gate", () => {
  it("skips the registry pull when the image is already present locally (delivered dev tag)", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec } = firstBootExecutor({ imagePresent: true });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {}); // verifyEngine may fail on the stub; we only assert the pull

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(false);
  });

  it("pulls when the image is absent locally (prod)", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec } = firstBootExecutor({ imagePresent: false });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {});

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(true);
  });

  // From-source (dev) backstop: an absent unpublished tag means the control-plane
  // build/ship didn't complete. Throw a clear error rather than a 404-ing pull.
  it("throws instead of pulling an absent image when managed images are from source", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    setManagedImagesFromSource("mail", true);
    const { executor, streamExec } = firstBootExecutor({ imagePresent: false });

    await expect(
      ensureContainerMail(executor, { domain: "example.com", secrets: {}, onLog: () => {} }),
    ).rejects.toThrow(/from-source mail engine image .* isn't on this server/);

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(false);
  });
});

describe("ensureContainerMail swap", () => {
  it("swaps a running engine onto a new tag with no pull when that tag is already present", async () => {
    // The delivered dev tag differs from the running engine's tag (the source hash
    // moved), so it's stale — but it's already on the box, so the swap runs no pull.
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
    const exec = vi.fn(async (cmd: string) => {
      // Engine is running on an OLDER tag → stale vs the pinned ref.
      if (cmd.includes(STATE_PROBE)) return stateLine("ghcr.io/x/openship-mail:old");
      // The pinned tag is already present locally (deliver shipped it) → no pull.
      if (cmd.includes("docker image inspect")) return "sha256:present\n";
      if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
      return "";
    });
    const executor = { exec, streamExec, writeFile: vi.fn(async () => {}) } as never;

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {});

    const cmds = streamExec.mock.calls.map(([cmd]) => String(cmd));
    // Swapped in place — a new engine `docker run`, and no pull (tag already present).
    expect(cmds.some((c) => c.includes("docker run") && c.includes("--network host"))).toBe(true);
    expect(cmds.some((c) => c.startsWith("docker pull"))).toBe(false);
  });
});

/**
 * Env-file record injection (GHSA-x2xg-5h5f-j5m9, second-order).
 *
 * The advisory's original sink — `export K='V'` into a file that `iRedMail.sh`
 * SOURCED as root — is gone. But an env-file is LINE-delimited, so the newline,
 * not the shell metacharacter, is the injection character here. The operator
 * supplies `adminPassword`, and it lands in this file verbatim.
 *
 * Why an extra record is not cosmetic: the engine runs `--network host
 * --cap-add NET_ADMIN` with host bind mounts (incl. `/etc/letsencrypt`), and bash
 * imports exported FUNCTIONS from the environment — so a
 * `BASH_FUNC_<name>%%=() { … }` record shadows a real binary the entrypoint
 * calls and runs as root inside the container. Docker's own env-file parser only
 * rejects an empty key or whitespace in the key, so `%%` passes it. Duplicate
 * keys are also last-wins, so an injected record can shadow FIRST_DOMAIN (which
 * the image templates into SQL run as the postgres superuser).
 *
 * So the writer must fail closed on anything that isn't a single clean record.
 */
/**
 * GH-564: on a redeploy over a RETAINED pgdata, the credential of record is the one the
 * cluster was initialised with, not the one this deploy generated - `POSTGRES_PASSWORD`
 * only takes effect during initdb. Handing the sidecar a fresh password fails auth,
 * db-bootstrap cannot load the schema, and `vmail` never appears.
 *
 * `initialised` controls the PG_VERSION probe; `retainedEnv` is the db.env already on the
 * host (null = the file is gone, the unrecoverable case).
 */
function retainedDbExecutor(opts: { initialised: boolean; retainedEnv: string | null }) {
  const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
  const exec = vi.fn(async (cmd: string) => {
    if (cmd.includes(STATE_PROBE)) return "";
    if (cmd.includes("docker version")) return "27.0.0\n";
    if (cmd.includes("docker image inspect")) return "sha256:abc\n";
    if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
    if (cmd.includes("PG_VERSION")) return opts.initialised ? "yes\n" : "";
    return "";
  });
  const writeFile = vi.fn(async (_path: string, _content: string) => {});
  const readFile = vi.fn(async (path: string) => {
    if (path.endsWith("db.env") && opts.retainedEnv !== null) return opts.retainedEnv;
    throw new Error("ENOENT");
  });
  return { executor: { exec, streamExec, writeFile, readFile } as never, writeFile, readFile };
}

function envWriteExecutor() {
  const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
  const exec = vi.fn(async (cmd: string) => {
    if (cmd.includes(STATE_PROBE)) return "";
    if (cmd.includes("docker version")) return "27.0.0\n";
    if (cmd.includes("docker image inspect")) return "sha256:abc\n";
    if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
    return "";
  });
  const writeFile = vi.fn(async (_path: string, _content: string) => {});
  return { executor: { exec, streamExec, writeFile } as never, writeFile, streamExec };
}

describe("engine env-file cannot be injected with extra records", () => {
  it("refuses a secret value containing a newline, and never writes it", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, writeFile, streamExec } = envWriteExecutor();

    await expect(
      ensureContainerMail(executor, {
        domain: "example.com",
        secrets: {
          DOMAIN_ADMIN_PASSWD_PLAIN:
            "aaaaaaaaaaaa\nBASH_FUNC_psql%%=() { echo pwned; }",
        },
        onLog: () => {},
      }),
    ).rejects.toThrow(/multiple lines/i);

    // Fail closed: nothing containing the payload reached the box, and the
    // container was never launched with a poisoned env-file.
    for (const [, content] of writeFile.mock.calls) {
      expect(String(content)).not.toContain("BASH_FUNC");
    }
    expect(
      streamExec.mock.calls.some(([c]) => String(c).includes("docker run")),
    ).toBe(false);
  });

  it("refuses a carriage return too (CR alone still ends a record)", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor } = envWriteExecutor();
    await expect(
      ensureContainerMail(executor, {
        domain: "example.com",
        secrets: { DOMAIN_ADMIN_PASSWD_PLAIN: "aaaaaaaaaaaa\rFIRST_DOMAIN=evil.tld" },
        onLog: () => {},
      }),
    ).rejects.toThrow(/multiple lines/i);
  });

  it("refuses a malformed variable NAME (blocks the BASH_FUNC_x%% form)", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor } = envWriteExecutor();
    await expect(
      ensureContainerMail(executor, {
        domain: "example.com",
        secrets: { "BASH_FUNC_psql%%": "() { echo pwned; }" },
        onLog: () => {},
      }),
    ).rejects.toThrow(/invalid variable name/i);
  });

  it("still writes ordinary secrets as one record per key", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, writeFile } = envWriteExecutor();

    await ensureContainerMail(executor, {
      domain: "example.com",
      // A password full of shell metacharacters is FINE — only the record shape
      // matters now, because nothing shell-parses this file.
      secrets: { DOMAIN_ADMIN_PASSWD_PLAIN: `a'b"c$(id)\`x\`;d` },
      onLog: () => {},
    }).catch(() => {});

    const engineEnv = writeFile.mock.calls
      .map(([, content]) => String(content))
      .find((c) => c.includes("DOMAIN_ADMIN_PASSWD_PLAIN="));
    expect(engineEnv).toBeDefined();
    expect(engineEnv).toContain(`DOMAIN_ADMIN_PASSWD_PLAIN=a'b"c$(id)\`x\`;d`);
    // One record per key: the password line must not have spawned another.
    const lines = (engineEnv as string).trim().split("\n");
    expect(lines.every((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))).toBe(true);
  });
});

describe("mail database credential over a retained pgdata (GH-564)", () => {
  const RETAINED = "POSTGRES_USER=postgres\nPOSTGRES_DB=vmail\nPOSTGRES_PASSWORD=old-cluster-pw\n";

  it("reuses the password the existing cluster was initialised with", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, writeFile } = retainedDbExecutor({
      initialised: true,
      retainedEnv: RETAINED,
    });

    await ensureContainerMail(executor, {
      domain: "example.com",
      // What a redeploy freshly generates - it must NOT win.
      secrets: { PGSQL_ROOT_PASSWD: "newly-generated-pw" },
      onLog: () => {},
    }).catch(() => {}); // the stub cannot finish verify; the env writes already happened

    const written = new Map(writeFile.mock.calls.map(([p, c]) => [String(p), String(c)]));
    const dbEnv = [...written.entries()].find(([p]) => p.endsWith("db.env"))?.[1] ?? "";
    const engineEnv = [...written.entries()].find(([p]) => p.endsWith("engine.env"))?.[1] ?? "";

    expect(dbEnv).toContain("POSTGRES_PASSWORD=old-cluster-pw");
    expect(dbEnv).not.toContain("newly-generated-pw");
    // The engine's first-boot bootstrap connects as the superuser, so it needs the SAME
    // credential - otherwise the schema load fails auth even though the sidecar is fine.
    expect(engineEnv).toContain("PGSQL_ROOT_PASSWD=old-cluster-pw");
    expect(engineEnv).not.toContain("newly-generated-pw");
  });

  it("uses the generated password on a genuine first install", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, writeFile, readFile } = retainedDbExecutor({
      initialised: false,
      retainedEnv: null,
    });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: { PGSQL_ROOT_PASSWD: "newly-generated-pw" },
      onLog: () => {},
    }).catch(() => {});

    const dbEnv =
      writeFile.mock.calls.map(([p, c]) => [String(p), String(c)] as const).find(([p]) => p.endsWith("db.env"))?.[1] ??
      "";
    expect(dbEnv).toContain("POSTGRES_PASSWORD=newly-generated-pw");
    // No cluster on disk, so no reason to read the old file at all.
    expect(readFile).not.toHaveBeenCalled();
  });

  it("refuses to mint a password an existing cluster cannot have", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, writeFile } = retainedDbExecutor({ initialised: true, retainedEnv: null });

    // Silently generating here produces a sidecar that cannot authenticate and an error
    // far from its cause, so this must abort and name the recoveries.
    await expect(
      ensureContainerMail(executor, {
        domain: "example.com",
        secrets: { PGSQL_ROOT_PASSWD: "newly-generated-pw" },
        onLog: () => {},
      }),
    ).rejects.toThrow(/initialised Postgres cluster/i);

    // And it must not have written a credential the cluster does not hold.
    const wroteDbEnv = writeFile.mock.calls.some(([p]) => String(p).endsWith("db.env"));
    expect(wroteDbEnv).toBe(false);
  });
});

/**
 * GH-630 — the account that runs `docker` must be able to read the env-files.
 *
 * Every other stub in this file is a SINGLE object, so `rootOrDegrade` degrades to it and
 * the elevated-write / unelevated-launch split is structurally invisible: the bug could not
 * fail a test even while it made mail setup impossible on a whole class of hosts. These
 * model the reporter's box instead — Openship running as a non-root user that is in the
 * docker group AND has passwordless sudo, the one arm where `rootOrDegrade` returns a real
 * `elevatedExecutor` wrapper and the writer's identity diverges from the launcher's.
 *
 * `nonRootSudoBox` enforces the single kernel rule that produced the failure: a file
 * published by a `sudo` command is root-owned 0600, and an unelevated
 * `docker run --env-file <it>` cannot open it, because docker resolves `--env-file`
 * client-side in the CLI's own process before it ever reaches the daemon socket. Being in
 * the docker group grants the socket, not the file.
 */
const SUDO = "sudo -n sh -c ";
const LOGIN_USER = "ubuntu";
const DB_ENV = `${MAIL_HOST_STATE_DIR}/db.env`;
const ENGINE_ENV = `${MAIL_HOST_STATE_DIR}/engine.env`;

// `opsh_uid` != 0 with `opsh_sudo=y` is what makes `privilegedExecutor` hand back
// `elevatedExecutor(executor)` rather than the caller's own object — i.e. the only profile
// on which these tests have anything to catch.
const PROBE_NON_ROOT_SUDO = [
  "opsh_begin=1",
  "opsh_os=Linux",
  "opsh_arch=x86_64",
  "opsh_uid=1000",
  `opsh_user=${LOGIN_USER}`,
  `opsh_home=/home/${LOGIN_USER}`,
  "opsh_osr:ID=ubuntu",
  'opsh_osr:VERSION_ID="24.04"',
  "opsh_pm=apt",
  "opsh_sm=systemd",
  "opsh_sudo=y",
  "opsh_fw=unknown",
  "opsh_libc=glibc",
  "opsh_selinux=absent",
  "opsh_container=n",
  "opsh_end=1",
].join("\n");

function nonRootSudoBox(
  opts: {
    runningImage?: string;
    imagePresent?: boolean;
    rootOwned?: string[];
    /** `"root"` models the arm where nothing needs to move — docker already runs as root. */
    login?: "root";
  } = {},
) {
  const loginIsRoot = opts.login === "root";
  const probe = loginIsRoot
    ? PROBE_NON_ROOT_SUDO.replace("opsh_uid=1000", "opsh_uid=0")
        .replace(`opsh_user=${LOGIN_USER}`, "opsh_user=root")
        .replace("opsh_sudo=y", "opsh_sudo=n")
    : PROBE_NON_ROOT_SUDO;
  const staged = new Map<string, string>();
  const published = new Map<string, string>();
  const rootOwned = new Set<string>(opts.rootOwned ?? []);
  const owners = new Map<string, string>();
  const readOnly = new Set<string>();
  /**
   * Directories the login user may SEARCH. Seeded empty on purpose: this box is the
   * umask-027 one, where `mkdir -p` leaves the tree 0750 root:root, so a chown that isn't
   * accompanied by a traversal grant still cannot be opened.
   */
  const traversable = new Set<string>();
  /** Every launch that tried to read a root-owned env-file it had no permission for. */
  const denied: string[] = [];

  const elevated = (cmd: string) => cmd.startsWith(SUDO);
  // Unwrap one layer of `elevateCommand` so the stub matches on the real command.
  const unwrap = (cmd: string) =>
    elevated(cmd)
      ? cmd.slice(SUDO.length).replace(/^'/, "").replace(/'$/, "").replace(/'\\''/g, "'")
      : cmd;

  const streamExec = vi.fn(async (cmd: string) => {
    const command = unwrap(cmd);
    if (command.includes("--env-file")) {
      const target = [DB_ENV, ENGINE_ENV].find((path) => command.includes(path));
      // Two independent ways the client-side open fails as the login user: the file is
      // root's, or a directory on the way to it is not searchable.
      const unreachable =
        target &&
        !loginIsRoot &&
        (rootOwned.has(target) ||
          ![`${MAIL_HOST_STATE_DIR}`, "/var/lib/openship"].every((d) => traversable.has(d)));
      if (target && unreachable && !elevated(cmd)) {
        denied.push(target);
        return { code: 125, output: `docker: --env-file: open ${target}: permission denied\n` };
      }
    }
    return { code: 0, output: "" };
  });

  const exec = vi.fn(async (cmd: string) => {
    const command = unwrap(cmd);
    if (command.includes("opsh_begin")) return probe;
    if (command.includes(STATE_PROBE)) {
      return opts.runningImage ? stateLine(opts.runningImage) : "";
    }
    if (command.includes("docker version")) return "27.0.0\n";
    if (command.includes("docker image inspect")) return opts.imagePresent ? "sha256:abc\n" : "";
    if (command.includes("/proc/net/tcp")) return PROC_LISTENING;
    // `elevatedExecutor.writeFile` publishes by staging unelevated, then `chown 0:0` + `mv`
    // as root — which is where a file becomes root-owned and unreadable to the launcher.
    const mv = /mv -f '([^']+)' '([^']+)'/.exec(command);
    if (mv && command.includes("chown 0:0")) {
      published.set(mv[2], staged.get(mv[1]) ?? "");
      rootOwned.add(mv[2]);
    }
    // ...and the fix's handover gives it back, read-only, with the path made traversable.
    const chown = /chown '([^']+)' '([^']+)'/.exec(command);
    if (chown && elevated(cmd)) {
      owners.set(chown[2], chown[1]);
      rootOwned.delete(chown[2]);
      for (const m of command.matchAll(/chmod 400 '([^']+)'/g)) readOnly.add(m[1]);
      // `chmod a+x <dir> <dir>` — one call, both path components.
      const dirs = /chmod a\+x '([^']+)' '([^']+)'/.exec(command);
      if (dirs) {
        traversable.add(dirs[1]);
        traversable.add(dirs[2]);
      }
    }
    return "";
  });

  const writeFile = vi.fn(async (path: string, content: string) => {
    staged.set(path, content);
  });

  return {
    executor: { exec, streamExec, writeFile } as never,
    exec,
    streamExec,
    published,
    rootOwned,
    owners,
    readOnly,
    traversable,
    denied,
    elevated,
    /** Every docker command the run issued, launches and probes alike. */
    dockerCommands: () =>
      [...streamExec.mock.calls, ...exec.mock.calls]
        .map(([cmd]) => String(cmd))
        .filter((c) => unwrap(c).includes("docker ")),
  };
}

describe("mail bring-up on a non-root sudo box (GH-630)", () => {
  it("hands the env-files to the account that runs docker, and keeps docker on it", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const box = nonRootSudoBox({ imagePresent: false });

    await ensureContainerMail(box.executor, {
      domain: "example.com",
      secrets: { PGSQL_ROOT_PASSWD: "pw" },
      onLog: () => {},
    });

    // The bug: `docker: --env-file: open /var/lib/openship/mail/db.env: permission denied`,
    // reported as "the mail database container failed to become ready".
    expect(box.denied).toEqual([]);

    // Not vacuous — the elevated write really did publish both files root-owned first, and
    // the handover is what made them readable again.
    expect(box.published.has(DB_ENV)).toBe(true);
    expect(box.published.has(ENGINE_ENV)).toBe(true);
    expect(box.rootOwned.has(DB_ENV)).toBe(false);
    expect(box.rootOwned.has(ENGINE_ENV)).toBe(false);

    // The other half of the fix, and the one a future change is most likely to undo:
    // EVERY docker command runs as the one login identity. Elevating the launch instead
    // would also change which daemon it reaches (`sudo` drops DOCKER_HOST) and which
    // registry credentials it presents, so a rootless box could be told to launch a second
    // host-network engine and report success.
    const docker = box.dockerCommands();
    expect(docker.length).toBeGreaterThan(0);
    expect(docker.filter((c) => box.elevated(c))).toEqual([]);
  });

  /**
   * The half a create-path-only fix would miss. A swap writes no env-file, so it launches
   * against the root-owned `engine.env` a PREVIOUS install left behind — and because
   * `swapManagedImage` re-invokes the same callback to roll back, both attempts fail and a
   * healthy engine is reported `mailDown` with nothing naming permissions.
   */
  it("repairs a pre-existing root-owned engine.env before an image swap", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const box = nonRootSudoBox({
      runningImage: "ghcr.io/x/openship-mail:old",
      imagePresent: true,
      rootOwned: [ENGINE_ENV],
    });

    const res = await ensureContainerMail(box.executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(box.denied).toEqual([]);
    expect(res.updated).toBe(true);
    expect(res.mailDown).toBeFalsy();
    expect(box.rootOwned.has(ENGINE_ENV)).toBe(false);
    expect(box.dockerCommands().filter((c) => box.elevated(c))).toEqual([]);

    // Repair only — a swap must never rewrite the secret env-files, which are provisioned
    // once by the mail wizard and are not re-derivable.
    expect(box.published.has(ENGINE_ENV)).toBe(false);
  });

  /**
   * Ownership is not reach. The tree is created by a bare `mkdir -p` that inherits the sudo
   * session's umask, so on a host whose login.defs sets UMASK 027 it lands 0750 root:root and
   * the login user cannot SEARCH it — the chown succeeds, the open still fails with the exact
   * same message, and nothing warns. `traversable` starts empty here precisely to model that
   * box, so a handover that only chowns leaves `denied` non-empty.
   */
  it("makes the path traversable, not just the file owned", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const box = nonRootSudoBox({ imagePresent: true });

    await ensureContainerMail(box.executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(box.denied).toEqual([]);
    // Search on both components, granted without read so the directory stays unlistable.
    expect(box.traversable.has(MAIL_HOST_STATE_DIR)).toBe(true);
    expect(box.traversable.has("/var/lib/openship")).toBe(true);
    const grants = box.exec.mock.calls.map(([c]) => String(c)).filter((c) => c.includes("chmod a+x"));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((c) => !/chmod a\+rx|chmod 0?755/.test(c))).toBe(true);
  });

  /**
   * The safety net the handover would otherwise remove. Before it, an unelevated rewrite of
   * db.env was refused because the file was root's — and that refusal is what stopped a
   * degraded re-run from overwriting the retained Postgres superuser password with a freshly
   * minted one (GH-564, whose recovery value is that file). Handing the file over at 0600
   * would make that write silently succeed; 0400 keeps the kernel refusing it, because the
   * mode binds the owner too.
   */
  it("leaves the handed-over env-files read-only so an unelevated rewrite still fails", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const box = nonRootSudoBox({ imagePresent: true });

    await ensureContainerMail(box.executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(box.readOnly.has(DB_ENV)).toBe(true);
    expect(box.readOnly.has(ENGINE_ENV)).toBe(true);
    expect(box.owners.get(DB_ENV)).toBe(LOGIN_USER);
    expect(box.owners.get(ENGINE_ENV)).toBe(LOGIN_USER);
  });

  // A root login is the arm where nothing needs to move: `rootOrDegrade` returns the
  // caller's own executor, so the file is already owned by whoever runs docker and the tree
  // is already traversable by it. Loosening either there would be a pure downgrade.
  it("touches neither ownership nor directory modes when the login is already root", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const box = nonRootSudoBox({ imagePresent: true, login: "root" });

    await ensureContainerMail(box.executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(box.denied).toEqual([]);
    const touched = box.exec.mock.calls
      .map(([c]) => String(c))
      .filter((c) => /chown|chmod a\+x|chmod 400/.test(c));
    expect(touched).toEqual([]);
  });
});
