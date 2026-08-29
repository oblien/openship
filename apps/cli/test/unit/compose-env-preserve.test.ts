import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * `openship up` regenerates `.env` from scratch, so anything it doesn't write is
 * gone. A plain re-run — the natural thing to do after `openship update` — used to
 * drop OPENSHIP_PUBLIC_URL, which is what puts the operator's domain in the API's
 * `trustedOrigins`. The stack came back up serving reads and 403ing every mutation
 * with ORIGIN_REJECTED: a live install where nothing can be saved, and an error
 * naming neither the cause nor the fix.
 *
 * These pin the rule: an explicit flag wins, otherwise the previous value is
 * carried, and a changed env actually reaches the containers (`env_file:` contents
 * are baked in at container CREATE time, so `up -d` alone keeps the old
 * environment and reports success).
 */

const h = vi.hoisted(() => ({
  sourceInstall: null as { repo: string; ref: string; dir: string } | null,
  existing: new Set<string>(),
  written: new Map<string, string>(),
  composeCalls: [] as string[][],
  /** `docker ps` rows for the port query: "<config_files>\t<published ports>". */
  dockerPsPorts: "",
  /** Postgres data volumes this box already has, by full volume name. */
  dbVolumes: new Set<string>(),
  /** `docker manifest inspect <ref>` result per ref. Default: the tag exists (#486). */
  manifestInspect: (_ref: string) => ({ status: 0, stdout: "{}", stderr: "" }),
  /**
   * #487 volume content probe: `docker run … alpine:3 … PG_VERSION`. Default "sub" =
   * an ordinary install (cluster in the pgdata/ subdir, every install since #350), so a
   * probed volume never blocks a test that didn't opt in.
   */
  pgProbe: (_volume: string) => ({ status: 0, stdout: "sub", stderr: "" }),
  /** `docker ps -a` label sweep rows (name\tproject\tconfig_files\tservice). */
  psAll: "",
  /** `ssh-keygen` for the host channel. Default: it works. */
  keygen: () => ({ status: 0, stdout: "", stderr: "" }),
  /**
   * `ss -ltn` / `netstat -ltn`. Default: sshd is listening on 22 — the ordinary box, so
   * the #509 prerequisite warning only fires for the tests that ask for it.
   */
  listeners: () => ({
    status: 0,
    stdout: "LISTEN 0      128                0.0.0.0:22         0.0.0.0:*",
    stderr: "",
  }),
  /**
   * The verification dial that proves sshd ACCEPTS the key we just authorized (#527), and
   * measures whether `sudo -n` works from that same session. Default: both do — so the
   * refusal warning only fires for the tests that ask for it, the same convention
   * `listeners` follows.
   *
   * The `openship-sudo=ok` marker is the contract, not decoration: the remote script ends
   * in `exit 0` so a refused SUDO can't be read as a refused LOGIN, which means the marker
   * — never the exit code — is what says the dial got through.
   *
   * Declared explicitly rather than left to the mock's status-0 fallthrough: a check
   * whose default answer is an accident is a check that stops being exercised the moment
   * the fallthrough changes.
   */
  channelAuth: () => ({ status: 0, stdout: "openship-sudo=ok\n", stderr: "" }),
}));

vi.mock("node:child_process", () => ({
  // LocalExecutor (pulled in by compose.ts for the vhost sanitize) uses execFile.
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "docker" && args[0] === "compose") h.composeCalls.push(args);
    // `docker volume inspect <name>`. Empty by default, so the password-reconcile path
    // stays out of the compose sequences most of these tests assert on.
    if (cmd === "docker" && args[0] === "volume") {
      return { status: h.dbVolumes.has(String(args[2])) ? 0 : 1, stdout: "", stderr: "" };
    }
    // Only the published-ports query (composeHeldPorts), not the label sweep below.
    if (cmd === "docker" && args[0] === "ps" && args.some((a) => a.includes("{{.Ports}}"))) {
      return { status: 0, stdout: h.dockerPsPorts, stderr: "" };
    }
    // The label sweep every container-ownership reader shares (PS_SWEEP_FORMAT).
    if (cmd === "docker" && args[0] === "ps") return { status: 0, stdout: h.psAll, stderr: "" };
    // Host-channel provisioning: the keypair, then the sshd prerequisite (#509).
    if (cmd === "ssh-keygen") return h.keygen();
    if (cmd === "ss" || cmd === "netstat") return h.listeners();
    // ...then the dial that asks sshd whether the key actually works (#527).
    if (cmd === "ssh") return h.channelAuth();
    // #486 preflight: registry manifest probe. Driven per-ref by h.manifestInspect.
    if (cmd === "docker" && args[0] === "manifest" && args[1] === "inspect") {
      return h.manifestInspect(String(args[2]));
    }
    // #487 PGDATA content probe: `docker run --rm -v <vol>:/from:ro alpine:3 sh -c '…PG_VERSION…'`.
    // Identified by the PG_VERSION script so it can't match the edge-state migration's own
    // `docker run`. Driven per-volume by h.pgProbe.
    if (cmd === "docker" && args[0] === "run" && args.some((a) => a.includes("PG_VERSION"))) {
      const mount = args.find((a) => a.endsWith(":/from:ro")) ?? "";
      return h.pgProbe(mount.slice(0, -":/from:ro".length));
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("node:fs", () => ({
  chmodSync: () => undefined,
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  realpathSync: (p: string) => String(p),
  rmSync: (p: string) => {
    h.written.delete(String(p));
    h.existing.delete(String(p));
  },
  readFileSync: (p: string) => {
    const v = h.written.get(String(p));
    // `code` matters: readEnvFile treats ENOENT as a first install and anything else as
    // an install whose secrets exist but are out of reach (#488).
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
  },
  renameSync: (from: string, to: string) => {
    h.written.set(String(to), h.written.get(String(from)) ?? "");
    h.existing.add(String(to));
    h.written.delete(String(from));
    h.existing.delete(String(from));
  },
}));

vi.mock("../../src/lib/source-install", () => ({
  readSourceInstall: () => h.sourceInstall,
}));

vi.mock("@repo/adapters/proxy", () => ({
  // compose.ts sanitizes the mounted vhost dir before `up`; no-op under test.
  sanitizeEdgeVhosts: async () => {},
}));

vi.mock("@repo/adapters", async () => {
  const lua = await import("../../../../packages/adapters/src/infra/openresty-lua");
  const ops = await import("../../../../packages/adapters/src/system/environment-ops");
  const fixtures = await import("../../../../packages/adapters/src/system/environment.fixtures");
  const { dockerSocketMock } = await import("../helpers/harness");
  return {
    ...dockerSocketMock,
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
    // The box this file's assertions describe, stated rather than measured: it runs
    // against a mocked `spawnSync`, so a real probe would report whatever machine the
    // suite happens to be on — and the sshd remedy asserted below is Debian's.
    // `envOps` is the real one, so the command still comes from the one table.
    envOps: ops.envOps,
    resolveLocalEnvironmentSync: () => fixtures.profileFixture(),
  };
});

import {
  canonicalComposeHostPath,
  composeEnvPorts,
  composeHeldPorts,
  composePaths,
  composePgDataRisk,
  composePlan,
  composePrefetch,
  composeUp,
  composeUpdate,
  missingPinnedImages,
  operatorEnvPassthrough,
  pinnedImagesReady,
  renderPgDataRefusal,
  resolveComposePorts,
  resolveEnvConfig,
  resolveImageVersion,
} from "../../src/lib/compose";
import { getFreePort } from "../../src/lib/ports";

/** The `.env` this run wrote, parsed back into key → value. */
function writtenEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (h.written.get(composePaths.env) ?? "").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Pretend this box already has an install configured with `env`. */
function seedEnv(env: Record<string, string>): void {
  h.written.set(
    composePaths.env,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );
  h.existing.add(composePaths.env);
  h.existing.add(composePaths.file);
}

/** compose verbs with `compose` and the `-f <file>` pairs stripped. */
const verbs = () =>
  h.composeCalls.map((args) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "compose") continue;
      if (args[i] === "-f") {
        i++;
        continue;
      }
      out.push(args[i]);
    }
    return out;
  });

const CONFIGURED = {
  COMPOSE_PROJECT_NAME: "openship",
  POSTGRES_PASSWORD: "pg-secret",
  BETTER_AUTH_SECRET: "auth-secret",
  INTERNAL_TOKEN: "internal-secret",
  API_PORT: "4100",
  DASHBOARD_PORT: "3100",
  OPENSHIP_PUBLIC_URL: "https://test.com",
  OPENSHIP_EXTRA_TRUSTED_ORIGINS: "http://192.168.1.50:3100",
  TRUST_PROXY: "true",
  OPENSHIP_IMAGE_REGISTRY: "registry.internal/oblien",
  OPENSHIP_HOST_CONTROL: "false",
  OPENSHIP_VERSION: "0.4.5",
  OPENSHIP_ACME_EMAIL: "ops@example.test",
  OPENSHIP_ACME_DIRECTORY_URL: "https://acme.example.test/directory",
  OPENSHIP_ACME_EAB_KID: "kid-123",
  OPENSHIP_ACME_EAB_HMAC_KEY: "c2VjcmV0",
  OPENSHIP_ACME_KEY_TYPE: "ec384",
  OPENSHIP_ACME_CA_BUNDLE: "/etc/ssl/private/acme-root.pem",
  OPENSHIP_ACME_TOS_AGREED: "true",
};

/**
 * The socket detector reads the ambient environment, so leaving any of these set
 * would make every `.env` in this file depend on the developer's own daemon.
 */
const DOCKER_SOCK = "/var/run/docker.sock";
const DOCKER_ENV_KEYS = [
  "OPENSHIP_DOCKER_SOCKET",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "XDG_RUNTIME_DIR",
  "SUDO_UID",
] as const;
const clearDockerEnv = () => {
  for (const key of DOCKER_ENV_KEYS) delete process.env[key];
};

/** `CONFIGURED` minus the keys named — an install whose `.env` stopped yielding them. */
const without = (...keys: string[]) =>
  Object.fromEntries(Object.entries(CONFIGURED).filter(([k]) => !keys.includes(k)));

beforeEach(() => {
  h.sourceInstall = null;
  // An ordinary rootful box: the daemon socket is where the api's mount defaults to,
  // so the #482 detection has nothing to write and nothing to warn about. The rootless
  // cases below take it back out.
  h.existing = new Set([DOCKER_SOCK]);
  h.written = new Map();
  h.composeCalls = [];
  h.dockerPsPorts = "";
  h.dbVolumes = new Set();
  h.manifestInspect = () => ({ status: 0, stdout: "{}", stderr: "" });
  h.pgProbe = () => ({ status: 0, stdout: "sub", stderr: "" });
  h.psAll = "";
  h.keygen = () => ({ status: 0, stdout: "", stderr: "" });
  h.listeners = () => ({
    status: 0,
    stdout: "LISTEN 0      128                0.0.0.0:22         0.0.0.0:*",
    stderr: "",
  });
  delete process.env.OPENSHIP_VERSION;
  clearDockerEnv();
});

afterEach(() => {
  delete process.env.OPENSHIP_VERSION;
  clearDockerEnv();
});

describe("resolveEnvConfig", () => {
  it("carries every operator setting forward when the run passes no flags", async () => {
    const cfg = resolveEnvConfig(CONFIGURED, {});
    expect(cfg.publicUrl).toBe("https://test.com");
    expect(cfg.extraTrustedOrigins).toBe("http://192.168.1.50:3100");
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.apiPort).toBe("4100");
    expect(cfg.dashPort).toBe("3100");
    expect(cfg.registry).toBe("registry.internal/oblien");
    expect(cfg.hostControl).toBe(false);
  });

  it("lets an explicit flag override the carried value", async () => {
    const cfg = resolveEnvConfig(CONFIGURED, {
      publicUrl: "https://new.example.com",
      apiPort: "4200",
    });
    expect(cfg.publicUrl).toBe("https://new.example.com");
    expect(cfg.apiPort).toBe("4200");
    expect(cfg.dashPort).toBe("3100"); // untouched flags still carry
  });

  it("falls back to defaults on a first install", async () => {
    const cfg = resolveEnvConfig({}, {});
    expect(cfg.publicUrl).toBeUndefined();
    expect(cfg.apiPort).toBe("4000");
    expect(cfg.dashPort).toBe("3001");
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.hostControl).toBe(true);
  });

  it("a public URL implies TRUST_PROXY (something terminates TLS in front)", async () => {
    expect(resolveEnvConfig({}, { publicUrl: "https://x.example.com" }).trustProxy).toBe(true);
  });

  it("keeps the product mode a mail install chose when the re-run passes no flag", async () => {
    expect(resolveEnvConfig({}, {}).productMode).toBe("platform");
    expect(resolveEnvConfig({}, { mail: true }).productMode).toBe("mail");
    // `--mail` is an install-time default, so a plain `up` (or `openship update`)
    // must not hand a mail box back the full platform shell.
    expect(resolveEnvConfig({ OPENSHIP_PRODUCT: "mail" }, {}).productMode).toBe("mail");
    // Turning it off is the dashboard's job (the DB setting wins over this env
    // var), but a hand-edited `.env` is honoured too.
    expect(resolveEnvConfig({ OPENSHIP_PRODUCT: "platform" }, {}).productMode).toBe("platform");
  });

  it("keeps host control OFF unless the flag says otherwise", async () => {
    // `--no-host-control` is absent on a re-run, so the install's choice stands.
    expect(resolveEnvConfig({ OPENSHIP_HOST_CONTROL: "false" }, {}).hostControl).toBe(false);
    expect(
      resolveEnvConfig({ OPENSHIP_HOST_CONTROL: "false" }, { noHostControl: false }).hostControl,
    ).toBe(true);
  });
});

/**
 * #490/#482: the container→host SSH endpoint used to be two literals in
 * `renderEnv`. A box where `host.docker.internal:22` is simply not the right
 * address — rootless Docker, sshd on another port — had nowhere to say so, and
 * every `openship up` rewrote a hand-edited `.env` back to the value that didn't
 * work.
 */
describe("resolveEnvConfig — the host channel endpoint", () => {
  it("defaults to the docker host alias on port 22", async () => {
    const cfg = resolveEnvConfig({}, {});
    expect(cfg.hostSshHost).toBe("host.docker.internal");
    expect(cfg.hostSshPort).toBe("22");
  });

  it("carries an operator's endpoint across a flagless re-run", async () => {
    const cfg = resolveEnvConfig(
      { OPENSHIP_HOST_SSH_HOST: "192.168.1.50", OPENSHIP_HOST_SSH_PORT: "2222" },
      {},
    );
    expect(cfg.hostSshHost).toBe("192.168.1.50");
    expect(cfg.hostSshPort).toBe("2222");
  });

  it("lets the flags override the carried endpoint", async () => {
    const cfg = resolveEnvConfig(
      { OPENSHIP_HOST_SSH_HOST: "192.168.1.50", OPENSHIP_HOST_SSH_PORT: "2222" },
      { hostSshHost: "10.0.0.4" },
    );
    expect(cfg.hostSshHost).toBe("10.0.0.4");
    expect(cfg.hostSshPort).toBe("2222"); // untouched flag still carries
  });
});

describe("the host alias is overridable in the compose file", () => {
  it("templates extra_hosts instead of pinning host-gateway", async () => {
    // Under rootless Docker `host-gateway` lands in RootlessKit's namespace, not the
    // host's (#482) — and `openship up` rewrites this file, so patching it by hand
    // isn't a workaround. OPENSHIP_HOST_GATEWAY has to be the seam.
    const { yaml } = composePlan({});
    expect(yaml).toContain(
      'extra_hosts: ["host.docker.internal:${OPENSHIP_HOST_GATEWAY:-host-gateway}"]',
    );
  });
});

describe("macOS edge bind sources (#692)", () => {
  it("resolves through the closest existing symlinked ancestor", () => {
    const realpath = (path: string): string => {
      if (path === "/var") return "/private/var";
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    };

    expect(
      canonicalComposeHostPath(
        "/var/lib/openship/edge/sites-enabled",
        "darwin",
        realpath,
      ),
    ).toBe("/private/var/lib/openship/edge/sites-enabled");
  });

  it("does not rewrite Linux mount paths", () => {
    const realpath = vi.fn(() => "/should-not-be-read");
    expect(canonicalComposeHostPath("/var/lib/openship/edge", "linux", realpath)).toBe(
      "/var/lib/openship/edge",
    );
    expect(realpath).not.toHaveBeenCalled();
  });
});

/**
 * The other half of #482: the api drives every deploy through the mounted Docker
 * socket, and a ROOTLESS daemon doesn't keep its socket at /var/run/docker.sock.
 * Docker creates a missing bind source as a DIRECTORY, so the wrong path here is a
 * stack that comes up healthy and then fails every container operation with a
 * transport error naming neither the path nor the cause.
 */
describe("composeUp — the api's docker socket mount (#482)", () => {
  const ROOTLESS = "/run/user/1000/docker.sock";
  /** The rootless box: nothing at the rootful path, whatever the operator's shell says. */
  const noRootfulDaemon = () => h.existing.delete(DOCKER_SOCK);

  it("templates the host side of the mount instead of hardcoding it", () => {
    const { yaml } = composePlan({});
    expect(yaml).toContain(
      "- ${OPENSHIP_DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock",
    );
    expect(yaml).not.toContain(`- ${DOCKER_SOCK}:${DOCKER_SOCK}`);
  });

  it("writes no key at all on an ordinary rootful box", async () => {
    // Nothing pinned → the compose file's own default stays in charge, so a later
    // daemon move isn't frozen into `.env` by a run that had no reason to write it.
    await composeUp({});
    expect(writtenEnv().OPENSHIP_DOCKER_SOCKET).toBeUndefined();
  });

  it("follows the daemon the docker CLI is talking to", async () => {
    // `up` shells out to `docker compose`, so the api must get THAT daemon's socket.
    process.env.DOCKER_HOST = `unix://${ROOTLESS}`;
    h.existing.add(ROOTLESS);
    await composeUp({});
    expect(writtenEnv().OPENSHIP_DOCKER_SOCKET).toBe(ROOTLESS);
  });

  it("finds a rootless socket the daemon advertises nowhere", async () => {
    // The reported box: rootless dockerd, and the `export DOCKER_HOST` its setup
    // printed lives in a shell profile this invocation never read.
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    noRootfulDaemon();
    h.existing.add(ROOTLESS);
    await composeUp({});
    expect(writtenEnv().OPENSHIP_DOCKER_SOCKET).toBe(ROOTLESS);
  });

  it("prefers the invoking user's runtime dir over root's under sudo", async () => {
    // Under `sudo openship up` both XDG_RUNTIME_DIR and the passwd entry describe
    // root, and /run/user/0 is not where the operator's rootless daemon is.
    process.env.XDG_RUNTIME_DIR = "/run/user/0";
    process.env.SUDO_UID = "1000";
    noRootfulDaemon();
    h.existing.add(ROOTLESS);
    await composeUp({});
    expect(writtenEnv().OPENSHIP_DOCKER_SOCKET).toBe(ROOTLESS);
  });

  it("keeps an operator's pinned path across a flagless re-run", async () => {
    // The fix for #482 went in `.env` by hand, and the next `up` overwrote it.
    // Detection would answer the rootful default here; the pin outranks it.
    seedEnv({ ...CONFIGURED, OPENSHIP_DOCKER_SOCKET: ROOTLESS });
    h.existing.add(ROOTLESS);

    await composeUp({});

    expect(writtenEnv().OPENSHIP_DOCKER_SOCKET).toBe(ROOTLESS);
    // Carried as a MANAGED key, not adopted as operator config: the #485 passthrough
    // copies lines verbatim, so a run that stopped emitting this would pin it forever.
    expect(h.written.get(composePaths.env)).not.toContain("# Preserved from your existing .env");
  });

  it("lets the shell override the pinned .env value", async () => {
    seedEnv({ ...CONFIGURED, OPENSHIP_DOCKER_SOCKET: ROOTLESS });
    process.env.OPENSHIP_DOCKER_SOCKET = "/var/run/docker-alt.sock";
    h.existing.add("/var/run/docker-alt.sock");
    await composeUp({});
    expect(writtenEnv().OPENSHIP_DOCKER_SOCKET).toBe("/var/run/docker-alt.sock");
  });

  describe("the socket isn't there", () => {
    let warned: string[];
    beforeEach(() => {
      warned = [];
      vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => warned.push(a.join(" ")));
    });
    afterEach(() => vi.restoreAllMocks());
    const said = () => warned.filter((w) => w.includes("empty DIRECTORY"));

    it("names the path, the silent failure and the override", async () => {
      process.env.DOCKER_HOST = `unix://${ROOTLESS}`;
      await composeUp({});

      const msg = said().join("\n");
      expect(msg).toContain(ROOTLESS);
      expect(msg).toContain("OPENSHIP_DOCKER_SOCKET=");
      expect(msg).toContain("#482");
    });

    it("says it once per run, not once per materialize", async () => {
      // `up` materializes twice (the prefetch has to write `.env` before it can pull).
      process.env.DOCKER_HOST = `unix://${ROOTLESS}`;
      composePrefetch({});
      expect(said()).toHaveLength(1);

      await composeUp({ alreadyFetched: true });
      expect(said()).toHaveLength(1);
    });

    it("stays quiet when the socket is on the box", async () => {
      await composeUp({});
      expect(said()).toEqual([]);
    });
  });
});

describe("resolveEnvConfig — bind interface (0.0.0.0 elimination)", () => {
  it("leaves the interface unset on a local install (no public URL) → compose loopback default", async () => {
    // Nothing pinned, nothing exposed off-box: OPENSHIP_BIND_ADDR is omitted so the
    // compose fallback (${OPENSHIP_BIND_ADDR:-127.0.0.1}) keeps the ports on loopback.
    expect(resolveEnvConfig({}, {}).bindAddr).toBeUndefined();
  });

  it("publishes on all interfaces when a public URL is configured (non-breaking remote default)", async () => {
    // A configured public URL is an explicit decision to be reachable off-host, so we
    // publish publicly rather than trap the box behind loopback with no domain served.
    expect(resolveEnvConfig({}, { publicUrl: "https://x.example.com" }).bindAddr).toBe("0.0.0.0");
    // Same when the URL was carried from a prior install rather than passed as a flag.
    expect(resolveEnvConfig({ OPENSHIP_PUBLIC_URL: "https://x.example.com" }, {}).bindAddr).toBe(
      "0.0.0.0",
    );
  });

  it("an explicitly pinned interface always wins over the public-URL default", async () => {
    // A domain-fronted box that pins loopback (edge reaches it over loopback) must
    // NOT be silently re-exposed on 0.0.0.0 just because a public URL is set.
    expect(
      resolveEnvConfig(
        { OPENSHIP_PUBLIC_URL: "https://x.example.com", OPENSHIP_BIND_ADDR: "127.0.0.1" },
        {},
      ).bindAddr,
    ).toBe("127.0.0.1");
  });
});

describe("composeUp — re-run on a configured install", () => {
  it("does not drop the public URL (the ORIGIN_REJECTED regression)", async () => {
    seedEnv(CONFIGURED);
    const res = await composeUp({});
    expect(res.ok).toBe(true);

    const env = writtenEnv();
    expect(env.OPENSHIP_PUBLIC_URL).toBe("https://test.com");
    expect(env.OPENSHIP_EXTRA_TRUSTED_ORIGINS).toBe("http://192.168.1.50:3100");
    expect(env.TRUST_PROXY).toBe("true");
    // Secrets keep their existing values, as before.
    expect(env.INTERNAL_TOKEN).toBe("internal-secret");
    expect(env.POSTGRES_PASSWORD).toBe("pg-secret");
    expect(env.OPENSHIP_ACME_EMAIL).toBe("ops@example.test");
    expect(env.OPENSHIP_ACME_DIRECTORY_URL).toBe("https://acme.example.test/directory");
    expect(env.OPENSHIP_ACME_EAB_KID).toBe("kid-123");
    expect(env.OPENSHIP_ACME_EAB_HMAC_KEY).toBe("c2VjcmV0");
    expect(env.OPENSHIP_ACME_KEY_TYPE).toBe("ec384");
    expect(env.OPENSHIP_ACME_CA_BUNDLE).toBe("/etc/ssl/private/acme-root.pem");
    expect(env.OPENSHIP_ACME_TOS_AGREED).toBe("true");
  });

  it("reports the EFFECTIVE ports, not the defaults", async () => {
    seedEnv(CONFIGURED);
    const res = await composeUp({});
    expect(res.apiPort).toBe("4100");
    expect(res.dashPort).toBe("3100");
  });

  it("keeps a pinned publish interface across a re-run", async () => {
    // Same failure shape as the dropped public URL: `.env` is regenerated from
    // scratch, so a key nothing writes is a key that disappears — here silently
    // republishing the api + dashboard on every interface of the box.
    seedEnv({ ...CONFIGURED, OPENSHIP_BIND_ADDR: "127.0.0.1" });
    await composeUp({});
    expect(writtenEnv().OPENSHIP_BIND_ADDR).toBe("127.0.0.1");
  });

  it("tells the api which dashboard port to route the domain to", async () => {
    // The self-app boot reconcile points the operator's domain at
    // 127.0.0.1:OPENSHIP_DASHBOARD_PORT, which silently defaults to 3001 when the
    // key is absent. Ports are dynamic, so omitting it publishes a domain routed to
    // a port nothing listens on.
    seedEnv(CONFIGURED);
    await composeUp({});
    const env = writtenEnv();
    expect(env.OPENSHIP_DASHBOARD_PORT).toBe(env.DASHBOARD_PORT);
    expect(env.OPENSHIP_DASHBOARD_PORT).toBe("3100");
  });
});

describe("compose port resolution", () => {
  it("prefers the ports the install is already configured with", async () => {
    seedEnv(CONFIGURED);
    expect(composeEnvPorts()).toEqual({ api: 4100, dashboard: 3100 });
  });

  it("has no preference on a first install", async () => {
    expect(composeEnvPorts()).toEqual({ api: undefined, dashboard: undefined });
  });

  it("ignores a junk port in the .env rather than proposing NaN", async () => {
    seedEnv({ ...CONFIGURED, API_PORT: "not-a-port", DASHBOARD_PORT: "0" });
    expect(composeEnvPorts()).toEqual({ api: undefined, dashboard: undefined });
  });

  it("counts the ports OUR OWN stack publishes as reclaimable", async () => {
    // Both host and IPv6 mappings for the same container port, plus a foreign
    // container that must not be claimed as ours.
    h.dockerPsPorts = [
      `${composePaths.file}\t0.0.0.0:4100->4100/tcp, [::]:4100->4100/tcp`,
      `${composePaths.file}\t0.0.0.0:3100->3100/tcp`,
      `/srv/other/docker-compose.yml\t0.0.0.0:9999->9999/tcp`,
      `\t`,
    ].join("\n");

    const held = composeHeldPorts();
    expect(held.sort()).toEqual([3100, 4100]);
    expect(held).not.toContain(9999);
  });

  it("resolves a flagless re-run back to the install's own ports", async () => {
    // End-to-end wiring of the preference chain: no flags, so the `.env` decides and
    // a running stack's own ports are reclaimable rather than "occupied". (That the
    // reclaim actually survives a HELD port is pinned in ports.test.ts, against a
    // real bound socket.) Probing is kept on loopback so the test binds nothing
    // externally.
    seedEnv({ ...CONFIGURED, OPENSHIP_BIND_ADDR: "127.0.0.1" });
    h.dockerPsPorts = `${composePaths.file}\t0.0.0.0:4100->4100/tcp, 0.0.0.0:3100->3100/tcp`;

    const r = await resolveComposePorts({});
    expect(r.api).toBe(4100);
    expect(r.dashboard).toBe(3100);
    expect(r.switched).toEqual({ api: false, dashboard: false });
  });

  it("lets an explicit --port outrank the configured one", async () => {
    seedEnv({ ...CONFIGURED, OPENSHIP_BIND_ADDR: "127.0.0.1" });
    // A port this box genuinely has free, so the assertion is about precedence and
    // not about whatever happens to be listening on the machine running the tests.
    const wanted = await getFreePort();

    const r = await resolveComposePorts({ api: String(wanted) });

    expect(r.api).toBe(wanted);
    expect(r.dashboard).toBe(3100);
  });

  it("leaves the containers alone when nothing changed", async () => {
    // Seeded from a real render, not a hand-written fixture: the detector compares
    // the rendered file byte-for-byte, so "unchanged" has to mean what `up` itself
    // would have written last time.
    await composeUp({ publicUrl: "https://test.com", version: "0.4.6" });
    h.composeCalls = [];

    await composeUp({ version: "0.4.6" });
    expect(verbs()).toContainEqual(["up", "-d"]);
    expect(verbs().some((v) => v.includes("--force-recreate"))).toBe(false);
    // ...and the URL is still there, which is the whole point.
    expect(writtenEnv().OPENSHIP_PUBLIC_URL).toBe("https://test.com");
  });

  it("force-recreates the env-consuming services when the env changed", async () => {
    seedEnv(CONFIGURED);
    await composeUp({ publicUrl: "https://moved.example.com" });
    // env_file contents are baked in at create time — without this the fix is a no-op.
    expect(verbs()).toContainEqual([
      "up",
      "-d",
      "--force-recreate",
      "api",
      "dashboard",
      "edge",
    ]);
  });

  it("does not force-recreate on a first install (nothing exists yet)", async () => {
    const res = await composeUp({ publicUrl: "https://fresh.example.com" });
    expect(res.ok).toBe(true);
    expect(verbs()).toContainEqual(["up", "-d"]);
    expect(verbs().some((v) => v.includes("--force-recreate"))).toBe(false);
  });

  /**
   * One `openship up` materializes TWICE — `composePrefetch` has to write `.env` before
   * `docker compose pull` can interpolate the registry and tag out of it, then `composeUp`
   * renders again. The second pass therefore compared `.env` against the FIRST pass's own
   * write, always concluded "unchanged", and skipped the recreate: `.env` showed the new
   * value while the containers kept the environment they were created with.
   *
   * That made #509's remedy hollow. `openship up` provisions the host channel into
   * `.env`, the api container keeps running without OPENSHIP_HOST_SSH_HOST, and the next
   * deploy fails with the very error the operator ran `up` to fix. The prefetch's verdict
   * now travels to `composeUp`, which is why these two drive both halves in order rather
   * than calling `composeUp` alone as the tests above do.
   */
  it("recreates the env-consuming services after prefetch + up (the real `up` path)", async () => {
    seedEnv(CONFIGURED);
    const fetched = composePrefetch({ publicUrl: "https://moved.example.com" });
    expect(fetched).toEqual({ ok: true, envChanged: true });
    h.composeCalls = [];

    await composeUp({
      alreadyFetched: true,
      envChanged: fetched.envChanged,
      publicUrl: "https://moved.example.com",
    });
    expect(verbs()).toContainEqual(["up", "-d", "--force-recreate", "api", "dashboard", "edge"]);
  });

  it("keeps .env.bak pointing at the PRE-RUN env across both materializes", async () => {
    // The recovery copy exists because `.env` is the only place this install's generated
    // secrets live (#488). The second materialize used to replace it with a copy of the
    // first one's write, so the bytes it was meant to preserve were already gone.
    seedEnv(CONFIGURED);
    composePrefetch({ publicUrl: "https://moved.example.com" });
    await composeUp({ alreadyFetched: true, publicUrl: "https://moved.example.com" });

    const bak = h.written.get(composePaths.envBackup) ?? "";
    expect(bak).toContain("OPENSHIP_PUBLIC_URL=https://test.com");
    expect(bak).not.toContain("moved.example.com");
  });

  it("recreates the api when a re-run changes whether it HAS a host channel", async () => {
    // The #509 change itself, in the direction this platform can drive: an install whose
    // `.env` carried the channel, re-run where provisioning yields nothing (non-Linux
    // here, a failed keygen in the field), so the keys are dropped. Either direction has
    // to reach the container — an api still booted with OPENSHIP_HOST_SSH_HOST after the
    // key went away fails host ops on a channel `.env` says it hasn't got, and an api
    // booted without it keeps failing them after `openship up` provisioned one.
    seedEnv({
      ...CONFIGURED,
      OPENSHIP_HOST_CONTROL: "true",
      OPENSHIP_HOST_SSH_HOST: "host.docker.internal",
      OPENSHIP_HOST_SSH_USER: "root",
      OPENSHIP_HOST_SSH_PORT: "22",
      OPENSHIP_HOST_SSH_KEY: "/run/secrets/openship_host_key",
    });
    const fetched = composePrefetch({});
    expect(fetched.envChanged).toBe(true);
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    h.composeCalls = [];

    await composeUp({ alreadyFetched: true, envChanged: fetched.envChanged });
    expect(verbs()).toContainEqual(["up", "-d", "--force-recreate", "api", "dashboard", "edge"]);
  });

  it("still leaves the containers alone when the prefetch saw no change", async () => {
    await composeUp({ publicUrl: "https://test.com", version: "0.4.6" });
    const fetched = composePrefetch({ publicUrl: "https://test.com", version: "0.4.6" });
    expect(fetched.envChanged).toBe(false);
    h.composeCalls = [];

    await composeUp({
      alreadyFetched: true,
      envChanged: fetched.envChanged,
      publicUrl: "https://test.com",
      version: "0.4.6",
    });
    expect(verbs()).toContainEqual(["up", "-d"]);
    expect(verbs().some((v) => v.includes("--force-recreate"))).toBe(false);
  });

  it("renders api + dashboard to a loopback bind default, never a bare 0.0.0.0", async () => {
    // A local install writes no OPENSHIP_BIND_ADDR, so the compose FILE's fallback is
    // what decides the interface — it must be loopback, not Docker's all-interfaces
    // default. This is the file-level half of the 0.0.0.0 elimination.
    await composeUp({});
    const file = h.written.get(composePaths.file) ?? "";
    expect(file).toContain("${OPENSHIP_BIND_ADDR:-127.0.0.1}:${API_PORT:-4000}:${API_PORT:-4000}");
    expect(file).toContain(
      "${OPENSHIP_BIND_ADDR:-127.0.0.1}:${DASHBOARD_PORT:-3001}:${DASHBOARD_PORT:-3001}",
    );
    expect(file).not.toContain("0.0.0.0");
    // A local install leaves the key out entirely → the loopback fallback applies.
    expect(writtenEnv().OPENSHIP_BIND_ADDR).toBeUndefined();
  });

  it("writes an explicit 0.0.0.0 to .env for a remote install (public URL set)", async () => {
    await composeUp({ publicUrl: "https://remote.example.com" });
    expect(writtenEnv().OPENSHIP_BIND_ADDR).toBe("0.0.0.0");
  });
});

/**
 * #485: `openship up` regenerated `.env` from its own key list, so a variable the operator
 * added by hand (OPENSHIP_AUTH_MODE, or anything bespoke) vanished on the next run/upgrade
 * with no diff — every "add this to your .env" fix lasted exactly one `up`. The passthrough
 * carries anything the CLI doesn't own; these pin what counts as "not owned".
 */
describe("operatorEnvPassthrough (#485)", () => {
  it("carries a variable the CLI does not manage", () => {
    expect(
      operatorEnvPassthrough(new Set(["API_PORT"]), {
        API_PORT: "4000",
        OPENSHIP_AUTH_MODE: "local",
      }),
    ).toEqual(["OPENSHIP_AUTH_MODE=local"]);
  });

  it("preserves several unknown keys verbatim, in the file's own order", () => {
    // A value containing '=' round-trips unchanged — it is copied, not re-parsed.
    expect(
      operatorEnvPassthrough(new Set(["API_PORT"]), {
        MY_FLAG: "1",
        API_PORT: "4000",
        ANOTHER_ONE: "value=with=equals",
      }),
    ).toEqual(["MY_FLAG=1", "ANOTHER_ONE=value=with=equals"]);
  });

  it("drops keys the writer emitted this run — those are the CLI's", () => {
    expect(
      operatorEnvPassthrough(new Set(["OPENSHIP_PUBLIC_URL"]), {
        OPENSHIP_PUBLIC_URL: "https://x.example.com",
      }),
    ).toEqual([]);
  });

  it("never resurrects an omittable managed key (host channel / TRUST_PROXY)", () => {
    // The host channel is CLI-provisioned; a run that omits it (host control off, or
    // provisioning down) must not carry a stale line back as if the operator set it.
    expect(
      operatorEnvPassthrough(new Set<string>(), {
        OPENSHIP_HOST_SSH_USER: "root",
        OPENSHIP_HOST_KEY_PATH: "/x/id_ed25519",
        TRUST_PROXY: "true",
      }),
    ).toEqual([]);
  });

  it("is empty when there was no previous .env", () => {
    expect(operatorEnvPassthrough(new Set(["API_PORT"]), {})).toEqual([]);
  });
});

describe("composeUp — operator-set variables survive a re-run (#485)", () => {
  it("preserves OPENSHIP_AUTH_MODE and bespoke keys the CLI doesn't manage", async () => {
    seedEnv({ ...CONFIGURED, OPENSHIP_AUTH_MODE: "local", MY_CUSTOM_FLAG: "42" });
    const res = await composeUp({});
    expect(res.ok).toBe(true);

    const env = writtenEnv();
    expect(env.OPENSHIP_AUTH_MODE).toBe("local");
    expect(env.MY_CUSTOM_FLAG).toBe("42");
    // ...and the keys the CLI DOES manage are still intact (the existing behavior).
    expect(env.OPENSHIP_PUBLIC_URL).toBe("https://test.com");
    expect(env.POSTGRES_PASSWORD).toBe("pg-secret");

    // Carried under a labelled section, not silently folded into the managed block.
    expect(h.written.get(composePaths.env)).toContain("# Preserved from your existing .env");
  });

  it("keeps them across repeated re-runs, with no duplication or drift", async () => {
    seedEnv({ ...CONFIGURED, OPENSHIP_AUTH_MODE: "local", MY_CUSTOM_FLAG: "42" });
    await composeUp({});
    const first = writtenEnv();
    // Second run reads the first run's output as its `.env`.
    await composeUp({});
    const second = writtenEnv();

    expect(second.OPENSHIP_AUTH_MODE).toBe("local");
    expect(second.MY_CUSTOM_FLAG).toBe("42");
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
  });

  // OPENSHIP_PRODUCT is written on every run, including the "platform" default, so
  // it stays in the managed set and the passthrough can never adopt it as operator
  // config — which would pin the mode and make the Settings toggle look broken.
  it("writes the product mode as a managed key, sticky across re-runs", async () => {
    seedEnv(CONFIGURED);
    await composeUp({ mail: true });
    expect(writtenEnv().OPENSHIP_PRODUCT).toBe("mail");

    // Re-run with no flag: still mail, and still managed (nothing was "kept").
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await composeUp({});
    log.mockRestore();
    expect(writtenEnv().OPENSHIP_PRODUCT).toBe("mail");
    expect(h.written.get(composePaths.env)).not.toContain("# Preserved from your existing .env");
  });
});

describe("composeUpdate", () => {
  it("repins the version, regenerates both files, and keeps the config", async () => {
    seedEnv(CONFIGURED);
    expect(await composeUpdate("0.4.6")).toEqual({ applied: true, refused: false });

    const env = writtenEnv();
    expect(env.OPENSHIP_VERSION).toBe("0.4.6");
    expect(env.OPENSHIP_PUBLIC_URL).toBe("https://test.com");
    expect(env.API_PORT).toBe("4100");
    // The compose FILE is rewritten too — that's why operators were running
    // `openship up` afterwards, which is what dropped the config.
    expect(h.written.get(composePaths.file)).toContain("services:");
    // New images + a recreate, in that order.
    expect(verbs()).toContainEqual(["pull"]);
    expect(verbs().at(-1)?.slice(0, 3)).toEqual(["up", "-d", "--force-recreate"]);
  });

  it("is a no-op when there's no compose install", async () => {
    expect(await composeUpdate("0.4.6")).toEqual({ applied: false, refused: false });
    expect(h.composeCalls).toHaveLength(0);
  });

  // `openship update` used to answer a refusal with "re-run `openship update`, or
  // `openship up` to retry" — advice that can only refuse again. `refused` is what
  // lets it stay quiet and leave the refusal's own instructions standing (#488).
  it("reports a secret-rotation stop as refused, not as a failure to retry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    seedEnv(without("POSTGRES_PASSWORD"));
    h.dbVolumes.add("openship_postgres_data");

    expect(await composeUpdate("0.4.6")).toEqual({ applied: false, refused: true });
    err.mockRestore();
    expect(h.composeCalls).toHaveLength(0);
  });
});

/**
 * #486: the CLI writes OPENSHIP_VERSION=<its own version> into `.env`, pinning the
 * image tag to a release whose GHCR images may not be published yet — `openship up`
 * then died on docker's opaque `manifest unknown` with no way to override. The fix is
 * two parts: a version the operator can steer (flag > OPENSHIP_VERSION env > CLI build
 * version) and a read-only registry preflight that fails BEFORE the box is touched,
 * naming the missing image and a tag known good on this box.
 */
describe("resolveImageVersion (#486)", () => {
  it("takes an explicit flag over the env and the build default", () => {
    process.env.OPENSHIP_VERSION = "9.9.9";
    expect(resolveImageVersion({ version: "1.2.3" })).toBe("1.2.3");
  });

  it("uses OPENSHIP_VERSION from the environment when no flag is given", () => {
    process.env.OPENSHIP_VERSION = "2.0.0";
    expect(resolveImageVersion({})).toBe("2.0.0");
  });

  it("trims surrounding whitespace and treats a blank flag as unset", () => {
    process.env.OPENSHIP_VERSION = "2.0.0";
    expect(resolveImageVersion({ version: "  1.2.3  " })).toBe("1.2.3");
    // A whitespace-only flag is not a choice — it falls through to the env, not "".
    expect(resolveImageVersion({ version: "   " })).toBe("2.0.0");
  });

  it("falls back to 'latest' with no flag, no env, and no build-time version", () => {
    // __CLI_VERSION__ is unset under vitest (no build-time define), so the chain
    // bottoms out at the compose file's own ${OPENSHIP_VERSION:-latest} default.
    expect(resolveImageVersion({})).toBe("latest");
  });
});

describe("missingPinnedImages (#486)", () => {
  it("returns [] when the registry has all three images", () => {
    expect(missingPinnedImages("ghcr.io/oblien", "1.2.3")).toEqual([]);
  });

  it("names only the image the registry positively lacks", () => {
    h.manifestInspect = (ref) =>
      ref.includes("openship-dashboard")
        ? { status: 1, stdout: "", stderr: "manifest unknown: manifest unknown" }
        : { status: 0, stdout: "{}", stderr: "" };
    expect(missingPinnedImages("ghcr.io/oblien", "1.2.3")).toEqual([
      "ghcr.io/oblien/openship-dashboard:1.2.3",
    ]);
  });

  it("recognizes the registry's other 'not found' phrasings as missing", () => {
    h.manifestInspect = (ref) => ({
      status: 1,
      stdout: "",
      stderr: `no such manifest: ${ref}`,
    });
    expect(missingPinnedImages("ghcr.io/oblien", "1.2.3")).toEqual([
      "ghcr.io/oblien/openship-api:1.2.3",
      "ghcr.io/oblien/openship-dashboard:1.2.3",
      "ghcr.io/oblien/openship-edge:1.2.3",
    ]);
  });

  it("abandons the probe (null) on an inconclusive error, never guessing missing", () => {
    // Unauthorized / offline / no `manifest inspect` support must not read as "missing" —
    // a false block would strand a perfectly valid install. The pull stays the real gate.
    h.manifestInspect = () => ({
      status: 1,
      stdout: "",
      stderr: "unauthorized: authentication required",
    });
    expect(missingPinnedImages("ghcr.io/oblien", "1.2.3")).toBeNull();
  });

  it("probes the tag under whatever registry it is handed", () => {
    const seen: string[] = [];
    h.manifestInspect = (ref) => {
      seen.push(ref);
      return { status: 0, stdout: "{}", stderr: "" };
    };
    missingPinnedImages("registry.internal/oblien", "0.4.5");
    expect(seen).toEqual([
      "registry.internal/oblien/openship-api:0.4.5",
      "registry.internal/oblien/openship-dashboard:0.4.5",
      "registry.internal/oblien/openship-edge:0.4.5",
    ]);
  });
});

describe("pinnedImagesReady (#486)", () => {
  it("proceeds when every image is present", () => {
    expect(pinnedImagesReady({ version: "1.2.3" })).toBe(true);
  });

  it("proceeds when the probe is inconclusive (never a false block)", () => {
    h.manifestInspect = () => ({
      status: 1,
      stdout: "",
      stderr: "unauthorized: authentication required",
    });
    expect(pinnedImagesReady({ version: "1.2.3" })).toBe(true);
  });

  it("skips the check for a from-source install — it builds, it never pulls", () => {
    h.sourceInstall = { repo: "oblien/openship", ref: "main", dir: "/src" };
    for (const df of ["apps/api/Dockerfile", "apps/dashboard/Dockerfile", "apps/edge/Dockerfile"]) {
      h.existing.add(`/src/${df}`);
    }
    // Every manifest missing, yet a source build has nothing in the registry to want.
    h.manifestInspect = () => ({ status: 1, stdout: "", stderr: "manifest unknown" });
    expect(pinnedImagesReady({})).toBe(true);
  });

  it("blocks and explains — naming the image and both override forms — when the tag is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.manifestInspect = (ref) =>
      ref.endsWith(":9.9.9")
        ? { status: 1, stdout: "", stderr: "manifest unknown" }
        : { status: 0, stdout: "{}", stderr: "" };

    expect(pinnedImagesReady({ version: "9.9.9" })).toBe(false);

    const msg = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(msg).toContain("ghcr.io/oblien/openship-api:9.9.9");
    expect(msg).toContain("--image-version");
    expect(msg).toContain("OPENSHIP_VERSION=");
    err.mockRestore();
  });

  it("offers the previously installed tag as a known-good fallback", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // A configured box carries OPENSHIP_VERSION 0.4.5; the operator asks for 9.9.9,
    // whose images aren't published — 0.4.5 is proven good on this very box.
    seedEnv({ ...CONFIGURED, OPENSHIP_VERSION: "0.4.5" });
    h.manifestInspect = (ref) =>
      ref.endsWith(":9.9.9")
        ? { status: 1, stdout: "", stderr: "manifest unknown" }
        : { status: 0, stdout: "{}", stderr: "" };

    expect(pinnedImagesReady({ version: "9.9.9" })).toBe(false);

    const msg = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(msg).toContain("0.4.5");
    expect(msg).toContain("known good");
    err.mockRestore();
  });
});

describe("composeUp — image tag preflight + override (#486)", () => {
  it("aborts before touching the box when the pinned tag is missing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    seedEnv(CONFIGURED); // OPENSHIP_VERSION 0.4.5, registry registry.internal/oblien
    h.manifestInspect = (ref) =>
      ref.endsWith(":9.9.9")
        ? { status: 1, stdout: "", stderr: "manifest unknown" }
        : { status: 0, stdout: "{}", stderr: "" };

    const res = await composeUp({ version: "9.9.9" });

    expect(res.ok).toBe(false);
    // Still reports the install's effective ports so the caller can summarize.
    expect(res.apiPort).toBe("4100");
    expect(res.dashPort).toBe("3100");
    // Nothing pulled, nothing recreated — and the .env was NOT repinned to the bad tag.
    expect(h.composeCalls).toHaveLength(0);
    expect(writtenEnv().OPENSHIP_VERSION).toBe("0.4.5");
    err.mockRestore();
  });

  it("pins --image-version into the written .env on a fresh install", async () => {
    const res = await composeUp({ version: "1.2.3" });
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_VERSION).toBe("1.2.3");
  });

  it("honours OPENSHIP_VERSION from the environment when no flag is passed", async () => {
    process.env.OPENSHIP_VERSION = "2.0.0";
    await composeUp({});
    expect(writtenEnv().OPENSHIP_VERSION).toBe("2.0.0");
  });

  it("lets --image-version outrank the OPENSHIP_VERSION env var", async () => {
    process.env.OPENSHIP_VERSION = "2.0.0";
    await composeUp({ version: "1.2.3" });
    expect(writtenEnv().OPENSHIP_VERSION).toBe("1.2.3");
  });
});

/**
 * #488. `keepSecret` reuses whatever `.env` yields and generates the rest — correct on a
 * first install, silently destructive on a re-run whose `.env` stopped yielding. The
 * reported case: `up` announced "secrets preserved", minted a new POSTGRES_PASSWORD,
 * overwrote the file, and the api then crash-looped on `password authentication failed
 * for user "openship"` because the data volume still held the ORIGINAL password — with
 * the only copy of that password already gone.
 *
 * The rule these pin: a missing generated secret + a surviving data volume = stop, before
 * anything writes. Plus the two things that make the state diagnosable at all — a preview
 * that can't claim preservation it won't perform, and the replaced `.env` kept on disk.
 */
describe("composeUp — refuses to rotate secrets over a surviving data volume (#488)", () => {
  it("stops without writing when the .env no longer holds POSTGRES_PASSWORD", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    seedEnv(without("POSTGRES_PASSWORD"));
    h.dbVolumes.add("openship_postgres_data");
    const envBefore = h.written.get(composePaths.env);

    const res = await composeUp({});

    expect(res.ok).toBe(false);
    // Nothing pulled, nothing recreated, and — the point — the .env is byte-identical, so
    // the operator can still fix the file instead of hunting for a lost password.
    expect(h.composeCalls).toHaveLength(0);
    expect(h.written.get(composePaths.env)).toBe(envBefore);

    const msg = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(msg).toContain("POSTGRES_PASSWORD");
    expect(msg).toContain("openship_postgres_data");
    expect(msg).toContain("--reset-secrets");
    err.mockRestore();
  });

  it("stops on a lost BETTER_AUTH_SECRET too — it decrypts the stored env vars", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    seedEnv(without("BETTER_AUTH_SECRET"));
    h.dbVolumes.add("openship_postgres_data");

    expect((await composeUp({})).ok).toBe(false);
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("BETTER_AUTH_SECRET");
    err.mockRestore();
  });

  it("finds the volume under the legacy project name, not just the pinned one", async () => {
    // COMPOSE_PROJECT_NAME is exactly what an unreadable `.env` can't tell us, so the
    // probe covers both historical defaults (see composeProjectName).
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.dbVolumes.add("compose_postgres_data");

    expect((await composeUp({})).ok).toBe(false);
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("compose_postgres_data");
    err.mockRestore();
  });

  it("--reset-secrets is the way past it", async () => {
    seedEnv(without("POSTGRES_PASSWORD"));
    h.dbVolumes.add("openship_postgres_data");

    const res = await composeUp({ resetSecrets: true });

    expect(res.ok).toBe(true);
    expect(writtenEnv().POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    // The volume exists, so the run realigns the role's password to the new value —
    // otherwise the api would be left failing 28P01 (see reconcileDbPassword).
    expect(verbs()).toContainEqual(["up", "-d", "--wait", "postgres"]);
  });

  it("does not fire on a first install — there is no data to contradict", async () => {
    const res = await composeUp({});
    expect(res.ok).toBe(true);
    expect(writtenEnv().POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not fire when the .env is intact, volume or no volume", async () => {
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");

    const res = await composeUp({});

    expect(res.ok).toBe(true);
    expect(writtenEnv().POSTGRES_PASSWORD).toBe("pg-secret");
  });

  it("keeps the .env it replaced, so the previous secrets survive a bad run", async () => {
    seedEnv(CONFIGURED);
    const envBefore = h.written.get(composePaths.env);

    expect((await composeUp({})).ok).toBe(true);

    expect(h.written.get(composePaths.envBackup)).toBe(envBefore);
    // Written via a temp file + rename, so an interrupt can't leave `.env` half-written
    // (a truncated file still PARSES — just without the secrets — which is how this
    // state gets created in the first place).
    expect(h.written.has(composePaths.env + ".tmp")).toBe(false);
  });

  it("a first install has no previous .env to keep", async () => {
    expect((await composeUp({})).ok).toBe(true);
    expect(h.written.has(composePaths.envBackup)).toBe(false);
  });
});

describe("composePlan — the preview cannot claim preservation it won't perform (#488)", () => {
  const secretRow = (plan: ReturnType<typeof composePlan>, key: string) =>
    plan.settings.find((s) => s.key === key)?.value;

  it("labels a secret it would REPLACE as generated, not preserved", async () => {
    seedEnv(Object.fromEntries(Object.entries(CONFIGURED).filter(([k]) => k !== "POSTGRES_PASSWORD")));
    h.dbVolumes.add("openship_postgres_data");

    const plan = composePlan({});

    expect(secretRow(plan, "POSTGRES_PASSWORD")).toBe("<generated on this run>");
    expect(plan.newSecrets).toContain("POSTGRES_PASSWORD");
    // Untouched secrets are still reported as kept — the claim is per key, not per run.
    expect(secretRow(plan, "BETTER_AUTH_SECRET")).toBe("<preserved>");
    // `existing` is true here, which is exactly why it can't be the source of the
    // "secrets preserved" line on its own.
    expect(plan.existing).toBe(true);
    expect(plan.secretRotation).toEqual({
      volume: "openship_postgres_data",
      keys: ["POSTGRES_PASSWORD"],
    });
  });

  it("says preserved when every secret really is carried through", async () => {
    seedEnv(CONFIGURED);
    const plan = composePlan({});
    expect(secretRow(plan, "POSTGRES_PASSWORD")).toBe("<preserved>");
    expect(plan.newSecrets).toEqual([]);
    expect(plan.secretRotation).toBeNull();
  });

  it("reports no refusal for --reset-secrets, which waives it", async () => {
    seedEnv(Object.fromEntries(Object.entries(CONFIGURED).filter(([k]) => k !== "POSTGRES_PASSWORD")));
    h.dbVolumes.add("openship_postgres_data");
    expect(composePlan({ resetSecrets: true }).secretRotation).toBeNull();
    // Still honest about what it would generate.
    expect(composePlan({ resetSecrets: true }).newSecrets).toContain("POSTGRES_PASSWORD");
  });
});

/**
 * #487. `openship up` decides OPENSHIP_PGDATA — where Postgres keeps its cluster inside the
 * data volume — and the old heuristic ("the volume exists → it's at the mount ROOT") wrote
 * the root whenever a volume was present but `.env` had no pinned key (an upgrade from a
 * version that never persisted it, a restored/unreadable `.env`). But every install since
 * #350 puts the cluster in the pgdata/ SUBDIR, so Postgres saw the root as uninitialised,
 * ran initdb over a non-empty directory, and the whole stack died — a failure that reads
 * like volume corruption, so the tempting "fix" (delete the volume) destroys the database.
 *
 * The rule these pin: READ the volume for PG_VERSION rather than guess, take the root ONLY
 * when the cluster is actually there, and refuse (rather than write a guess) when the
 * volume holds data at neither known location.
 */
describe("composeUp — OPENSHIP_PGDATA is read from the volume, not guessed (#487)", () => {
  it("pins the pgdata/ subdir when a surviving volume's cluster is in the subdir", async () => {
    // The exact #487 regression: volume present, key unpinned, cluster in the subdir. The
    // old code wrote the ROOT here; this must write the subdir so Postgres finds its data.
    seedEnv(CONFIGURED); // no OPENSHIP_PGDATA — .env intact otherwise, so no rotation stop
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "sub", stderr: "" });

    const res = await composeUp({});

    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data/pgdata");
  });

  it("takes the mount root only when PG_VERSION is actually at the root", async () => {
    // A genuine pre-#350 install whose cluster IS at the root — moving it to the subdir
    // would orphan the data, so the root must be honoured when the probe confirms it.
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "root", stderr: "" });

    await composeUp({});
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data");
  });

  it("uses the subdir on a fresh install — no volume to probe", async () => {
    const res = await composeUp({});
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data/pgdata");
  });

  it("falls back to the subdir when docker can't probe (status != 0 → unknown)", async () => {
    // An inconclusive probe must never guess the root — the subdir is the non-crashing
    // choice, and the compose default besides.
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 1, stdout: "", stderr: "cannot connect to the Docker daemon" });

    const res = await composeUp({});
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/var/lib/postgresql/data/pgdata");
  });

  it("reuses a pinned OPENSHIP_PGDATA verbatim, without probing", async () => {
    // Sticky like COMPOSE_PROJECT_NAME: once decided, never re-derived — and never probed.
    seedEnv({ ...CONFIGURED, OPENSHIP_PGDATA: "/custom/pg" });
    h.dbVolumes.add("openship_postgres_data");
    let probed = false;
    h.pgProbe = () => {
      probed = true;
      return { status: 0, stdout: "root", stderr: "" };
    };

    await composeUp({});
    expect(writtenEnv().OPENSHIP_PGDATA).toBe("/custom/pg");
    expect(probed).toBe(false);
  });
});

describe("composeUp — refuses to guess OPENSHIP_PGDATA on an unrecognized volume (#487)", () => {
  it("stops without writing when a surviving volume holds data at neither known path", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "foreign", stderr: "" });
    const envBefore = h.written.get(composePaths.env);

    const res = await composeUp({});

    expect(res.ok).toBe(false);
    expect(res.refused).toBe(true);
    // Nothing pulled, nothing recreated, and the .env is byte-identical — the operator can
    // pin the path by hand instead of hunting for orphaned data.
    expect(h.composeCalls).toHaveLength(0);
    expect(h.written.get(composePaths.env)).toBe(envBefore);

    const msg = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(msg).toContain("openship_postgres_data");
    expect(msg).toContain("OPENSHIP_PGDATA");
    err.mockRestore();
  });

  it("does not fire when the cluster is recognized (subdir)", async () => {
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "sub", stderr: "" });
    expect((await composeUp({})).ok).toBe(true);
  });

  it("does not fire on a first install — there is no volume", async () => {
    expect((await composeUp({})).ok).toBe(true);
  });
});

describe("composePlan / renderPgDataRefusal — the dry run names the PGDATA refusal (#487)", () => {
  it("sets pgDataRisk when the volume is unrecognized", () => {
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "foreign", stderr: "" });
    expect(composePlan({}).pgDataRisk).toEqual({ volume: "openship_postgres_data" });
  });

  it("is null when the cluster is recognized", () => {
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "root", stderr: "" });
    expect(composePlan({}).pgDataRisk).toBeNull();
  });

  it("is null on a fresh install (no volume to probe)", () => {
    expect(composePlan({}).pgDataRisk).toBeNull();
  });

  it("names the volume, both candidate paths, and the manual pin", () => {
    const msg = renderPgDataRefusal({ volume: "openship_postgres_data" });
    expect(msg).toContain("openship_postgres_data");
    expect(msg).toContain("/var/lib/postgresql/data/pgdata");
    expect(msg).toContain("/var/lib/postgresql/data");
    expect(msg).toContain("OPENSHIP_PGDATA=");
  });

  it("uses the future tense for a dry run", () => {
    expect(renderPgDataRefusal({ volume: "v" }, { dryRun: true })).toContain("would REFUSE");
  });
});

/**
 * #509: `openship up` provisions the container→host SSH channel, and used to do it in
 * total silence. A failed keygen produced a bare `null` the call site threw away, so the
 * install reported success on a box where every host operation was already dead — and on a
 * RE-RUN it was worse than silent: the five OPENSHIP_HOST_* keys are omittable-managed, so
 * they vanished from `.env`, `.env` therefore differed, and compose force-recreated the api
 * without them. An install that had host control for months lost it to one transient
 * failure, with nothing on screen.
 *
 * These run with `process.platform` forced to linux, because that is the only platform
 * where a channel is provisioned at all (see plannedHostChannel) — and a non-Linux box
 * having none is the legitimate quiet case the tests above depend on.
 */
describe("composeUp — the host channel is provisioned out loud (#509)", () => {
  const realPlatform = process.platform;
  const asPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });

  /** The keypair on disk: the private half exists, the public half reads back. */
  const HOST_KEY = join(composePaths.dir, "host-ssh", "id_ed25519");
  const seedHostKey = () => {
    h.existing.add(HOST_KEY);
    h.written.set(`${HOST_KEY}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest openship-host-executor\n");
  };

  let warned: string[];
  let logged: string[];
  beforeEach(() => {
    asPlatform("linux");
    warned = [];
    logged = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => warned.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logged.push(a.join(" ")));
  });
  afterEach(() => {
    asPlatform(realPlatform);
    vi.restoreAllMocks();
  });

  it("reports WHY there is no channel, and continues — a degraded install, not a failed one", async () => {
    h.keygen = () => ({ status: 1, stdout: "", stderr: "ssh-keygen: /root: Permission denied" });

    const res = await composeUp({});

    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    const msg = warned.join("\n");
    // The cause exists nowhere else: every later surface sees only an unset env var.
    expect(msg).toContain("could NOT be provisioned");
    expect(msg).toContain("Permission denied");
    // ...and the framing that stops an operator tearing the box down over it.
    expect(msg).toContain("Ordinary deploys to this box still work");
    expect(msg).toContain("`openship doctor`");
  });

  it("says it once per run, not once per materialize", async () => {
    // `up` materializes twice — the prefetch has to write `.env` before it can pull, then
    // `composeUp` renders again (see ComposePrefetchResult) — and a dozen lines printed
    // twice reads as two separate faults.
    h.keygen = () => ({ status: 1, stdout: "", stderr: "no space left on device" });
    const said = () => warned.filter((w) => w.includes("could NOT be provisioned")).length;

    composePrefetch({});
    expect(said()).toBe(1);

    await composeUp({ alreadyFetched: true });
    expect(said()).toBe(1);
  });

  it("stays quiet when this platform can't have a channel", async () => {
    // `plannedHostChannel` returning null is not a fault — a warning here would fire on
    // every macOS/Windows install, which have no host.docker.internal SSH path at all.
    asPlatform(realPlatform === "linux" ? "darwin" : realPlatform);
    await composeUp({});
    expect(warned.join("\n")).not.toContain("Host control");
  });

  it("stays quiet when the operator turned host control off", async () => {
    await composeUp({ noHostControl: true });
    expect(warned.join("\n")).not.toContain("could NOT be provisioned");
  });

  it("keeps a working channel through a provisioning failure, without recreating the api", async () => {
    // The revocation-by-recreate. First run provisions; the second finds the public half
    // gone (a partly-wiped key dir) and must carry the previous values forward — byte for
    // byte, or the `.env` diff alone recreates the api without the channel.
    seedHostKey();
    await composeUp({});
    const first = writtenEnv();
    expect(first.OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    expect(first.OPENSHIP_HOST_KEY_PATH).toBe(HOST_KEY);

    h.written.delete(`${HOST_KEY}.pub`);
    h.composeCalls = [];
    warned = [];

    const res = await composeUp({});

    expect(res.ok).toBe(true);
    const second = writtenEnv();
    expect(second.OPENSHIP_HOST_SSH_HOST).toBe(first.OPENSHIP_HOST_SSH_HOST);
    expect(second.OPENSHIP_HOST_SSH_USER).toBe(first.OPENSHIP_HOST_SSH_USER);
    expect(second.OPENSHIP_HOST_SSH_PORT).toBe(first.OPENSHIP_HOST_SSH_PORT);
    expect(second.OPENSHIP_HOST_SSH_KEY).toBe(first.OPENSHIP_HOST_SSH_KEY);
    expect(second.OPENSHIP_HOST_KEY_PATH).toBe(first.OPENSHIP_HOST_KEY_PATH);
    // Nothing changed, so nothing is recreated — the api keeps the channel it is running with.
    expect(verbs()).toContainEqual(["up", "-d"]);
    expect(verbs().some((v) => v.includes("--force-recreate"))).toBe(false);
    expect(warned.join("\n")).toContain("Kept the host channel this install already had");
  });

  it("does not carry a channel whose key is gone — that would mount a directory", async () => {
    // Docker creates a missing bind-mount source as a DIRECTORY, so an env pointing
    // OPENSHIP_HOST_KEY_PATH at a deleted key hands the api a directory where the key
    // should be. Without the key there is no channel to keep.
    seedEnv({
      ...CONFIGURED,
      OPENSHIP_HOST_CONTROL: "true",
      OPENSHIP_HOST_SSH_HOST: "host.docker.internal",
      OPENSHIP_HOST_SSH_USER: "root",
      OPENSHIP_HOST_SSH_PORT: "22",
      OPENSHIP_HOST_SSH_KEY: "/run/secrets/openship_host_key",
      OPENSHIP_HOST_KEY_PATH: HOST_KEY,
    });
    h.keygen = () => ({ status: 1, stdout: "", stderr: "no space left on device" });

    await composeUp({});

    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    expect(writtenEnv().OPENSHIP_HOST_KEY_PATH).toBeUndefined();
    expect(warned.join("\n")).toContain("host operations refuse");
  });

  it("`--no-host-control` still removes the keys, and says that it did", async () => {
    seedHostKey();
    await composeUp({});
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    logged = [];

    await composeUp({ noHostControl: true });

    // The one case where these keys legitimately disappear — so it is also the one that
    // has to say so out loud.
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    expect(logged.join("\n")).toContain("dropped OPENSHIP_HOST_SSH_* from .env");
  });

  it("reports a host with no SSH server, and still writes the channel", async () => {
    // ssh-keygen is the openssh CLIENT and authorized_keys is just a file, so every step
    // of provisioning succeeds on a box with no sshd. The key stays authorized (it costs
    // nothing and is right the moment sshd starts); what changes is that we say so.
    seedHostKey();
    h.listeners = () => ({
      status: 0,
      stdout: "LISTEN 0      4096         127.0.0.53%lo:53         0.0.0.0:*",
      stderr: "",
    });

    const res = await composeUp({});

    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    const msg = warned.join("\n");
    expect(msg).toContain("nothing on this host is listening for SSH");
    // The unit name of the host in the mock above (Ubuntu → `ssh`), not a literal: the
    // RHEL family calls it `sshd` and Alpine has no systemctl, so this line printing
    // Debian's command everywhere did nothing on the hosts most likely to hit it.
    expect(msg).toContain("sudo systemctl enable --now ssh");
  });

  it("says nothing about sshd when the listener list can't be read", async () => {
    // A false "no SSH server here" sends an operator to fix a host that was fine.
    seedHostKey();
    h.listeners = () => ({ status: 1, stdout: "", stderr: "ss: command not found" });

    await composeUp({});

    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    expect(warned.join("\n")).not.toContain("listening for SSH");
  });

  /**
   * #527: a LISTENER is not an accepted key.
   *
   * The reporter's box passed every check above — key generated, `authorized_keys`
   * written, sshd listening on 22 — and the install said host control was on. The channel
   * was refused on every dial, which they discovered weeks later through an unrelated
   * feature, worded as their own stored credentials being wrong. The only thing that can
   * settle it is asking sshd, and nothing did.
   */
  it("does NOT write a channel sshd refuses on every account it could try", async () => {
    seedHostKey();
    h.channelAuth = () => ({
      status: 255,
      stdout: "",
      stderr: "root@127.0.0.1: Permission denied (publickey).",
    });

    const res = await composeUp({});

    // Not fatal — a degraded install is not a failed one — but the channel is NOT written.
    // Writing it was the second half of #527: `.env` pointed the api at a refusal it would
    // hit on every dial for the life of the install, and every surface downstream read that
    // as a configured, working channel.
    expect(res.ok).toBe(true);
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    const msg = warned.join("\n");
    expect(msg).toContain("REFUSED the channel's key");
    expect(msg).toContain("Permission denied (publickey).");
    // The three things that actually fix it. The reporter had none of them: every surface
    // said "re-run `openship up`", which on their box reproduced the same refusal.
    expect(msg).toContain("--host-ssh-user");
    expect(msg).toContain("PermitRootLogin prohibit-password");
    expect(msg).toContain("--no-host-control");
    expect(msg).toContain("Ordinary deploys to this box still work");
  });

  it("reports a connect failure as an address problem, not a refused key", async () => {
    // sshd is listening (the default `listeners`) and yet the dial never reached auth, so
    // the one thing this cannot be is the key. Every non-zero `ssh` exit used to be
    // reported as a refusal, which pointed at an authorized_keys sshd had never read.
    seedHostKey();
    h.channelAuth = () => ({
      status: 255,
      stdout: "",
      stderr: "ssh: connect to host 127.0.0.1 port 22: Connection refused",
    });

    await composeUp({});

    const msg = warned.join("\n");
    expect(msg).toContain("ADDRESS problem, not a key problem");
    expect(msg).toContain("ListenAddress");
    expect(msg).not.toContain("REFUSED the channel's key");
    // The address is the fault, not the account, so the channel still stands.
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
  });

  it("warns about root ops when the dialed session's own sudo is refused", async () => {
    // The measurement `hasPasswordlessSudo()` cannot make: a cached sudo ticket in the
    // operator's terminal answered yes for a box with no NOPASSWD rule, so this warning was
    // suppressed on exactly the installs that needed it — and the same stale yes authorized
    // the revoke that stripped their working root grant.
    seedHostKey();
    h.channelAuth = () => ({ status: 0, stdout: "openship-sudo=refused\n", stderr: "" });

    await composeUp({});

    // A working channel, so it IS written — just one with no route to root.
    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    expect(warned.join("\n")).toContain("no route to it");
  });

  it("pins the account with --host-ssh-user and records the pin separately", async () => {
    seedHostKey();

    await composeUp({ hostSshUser: "ops" });

    const env = writtenEnv();
    expect(env.OPENSHIP_HOST_SSH_USER).toBe("ops");
    // Two keys, deliberately: _USER records what provisioning SETTLED on and _USER_PIN what
    // the operator ASKED for. Conflating them would freeze the account a box happens to
    // have — including the refused `root` on every install #527 broke — and the fallback
    // that repairs those could never run.
    expect(env.OPENSHIP_HOST_SSH_USER_PIN).toBe("ops");
  });

  it("carries a pin across a re-run that passes no flag", async () => {
    // Deliberately NOT the CONFIGURED fixture: it sets OPENSHIP_HOST_CONTROL=false, so
    // there would be no channel to pin an account for.
    seedEnv({ OPENSHIP_HOST_SSH_USER_PIN: "ops" });
    seedHostKey();

    await composeUp({});

    expect(writtenEnv().OPENSHIP_HOST_SSH_USER).toBe("ops");
    expect(writtenEnv().OPENSHIP_HOST_SSH_USER_PIN).toBe("ops");
  });

  it("keeps the pin even on the run where the pinned account is refused", async () => {
    // The run that loses the pin must not be the one where it matters: a pin whose account
    // sshd refuses yields no channel, and dropping the key there would send the NEXT run
    // (after the operator fixed sshd) back to deciding for itself.
    seedEnv({ OPENSHIP_HOST_SSH_USER_PIN: "ops" });
    seedHostKey();
    h.channelAuth = () => ({
      status: 255,
      stdout: "",
      stderr: "ops@127.0.0.1: Permission denied (publickey).",
    });

    await composeUp({});

    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBeUndefined();
    expect(writtenEnv().OPENSHIP_HOST_SSH_USER_PIN).toBe("ops");
    // A pin is the one candidate: it must not fall back to root behind the operator's back.
    // Asserted on the accounts-tried clause (whitespace-normalized, since the note is
    // wrapped to the terminal) rather than on the word "root" anywhere — the remedies below
    // it legitimately mention `PermitRootLogin`.
    const msg = warned.join("\n").replace(/\s+/g, " ");
    expect(msg).toContain("authorized for `ops` and sshd is listening");
    expect(msg).not.toContain("`root` then");
  });

  it("stays quiet when the verification dial can't run at all", async () => {
    // No `ssh` client: the question was never asked, and answering "refused" would fail
    // an install that is fine — the mirror of the ss-not-installed case above.
    seedHostKey();
    h.channelAuth = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) });

    await composeUp({});

    expect(writtenEnv().OPENSHIP_HOST_SSH_HOST).toBe("host.docker.internal");
    expect(warned.join("\n")).not.toContain("REFUSED");
  });
});

describe("composePgDataRisk — the disk-facing gate entry (#487)", () => {
  it("reports the volume when the on-disk .env has no pinned key and the volume is foreign", () => {
    seedEnv(CONFIGURED);
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "foreign", stderr: "" });
    expect(composePgDataRisk()).toEqual({ volume: "openship_postgres_data" });
  });

  it("is null once OPENSHIP_PGDATA is pinned, without probing", () => {
    seedEnv({ ...CONFIGURED, OPENSHIP_PGDATA: "/var/lib/postgresql/data" });
    h.dbVolumes.add("openship_postgres_data");
    h.pgProbe = () => ({ status: 0, stdout: "foreign", stderr: "" });
    expect(composePgDataRisk()).toBeNull();
  });
});
