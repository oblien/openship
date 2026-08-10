import { describe, it, expect, beforeEach, vi } from "vitest";

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
}));

vi.mock("node:child_process", () => ({
  // LocalExecutor (pulled in by compose.ts for the vhost sanitize) uses execFile.
  execFile: (_c: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
    cb(null, { stdout: "" }),
  spawnSync: (cmd: string, args: string[] = []) => {
    if (cmd === "docker" && args[0] === "compose") h.composeCalls.push(args);
    // No pre-existing db volume → the password-reconcile path stays out of the
    // compose sequences these tests assert on.
    if (cmd === "docker" && args[0] === "volume") return { status: 1, stdout: "", stderr: "" };
    // Only the published-ports query (composeHeldPorts), not the container sweep
    // orphanedStackContainers runs with its own format.
    if (cmd === "docker" && args[0] === "ps" && args.some((a) => a.includes("{{.Ports}}"))) {
      return { status: 0, stdout: h.dockerPsPorts, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => h.existing.has(String(p)),
  mkdirSync: () => undefined,
  readFileSync: (p: string) => {
    const v = h.written.get(String(p));
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    h.written.set(String(p), String(data));
    h.existing.add(String(p));
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
  return {
    systemCatalog: { installs: { docker: () => ({ supported: false }) } },
    EDGE_HOST_STATE_DIR: lua.EDGE_HOST_STATE_DIR,
    EDGE_CONTAINER_MOUNTS: lua.EDGE_CONTAINER_MOUNTS,
    invalidateEdgeContainer: () => {},
    LocalExecutor: class {},
  };
});

import {
  composeEnvPorts,
  composeHeldPorts,
  composePaths,
  composeUp,
  composeUpdate,
  resolveComposePorts,
  resolveEnvConfig,
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

beforeEach(() => {
  h.sourceInstall = null;
  h.existing = new Set();
  h.written = new Map();
  h.composeCalls = [];
  h.dockerPsPorts = "";
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

  it("keeps host control OFF unless the flag says otherwise", async () => {
    // `--no-host-control` is absent on a re-run, so the install's choice stands.
    expect(resolveEnvConfig({ OPENSHIP_HOST_CONTROL: "false" }, {}).hostControl).toBe(false);
    expect(
      resolveEnvConfig({ OPENSHIP_HOST_CONTROL: "false" }, { noHostControl: false }).hostControl,
    ).toBe(true);
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

describe("composeUpdate", () => {
  it("repins the version, regenerates both files, and keeps the config", async () => {
    seedEnv(CONFIGURED);
    expect(await composeUpdate("0.4.6")).toBe(true);

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
    expect(await composeUpdate("0.4.6")).toBe(false);
    expect(h.composeCalls).toHaveLength(0);
  });
});
