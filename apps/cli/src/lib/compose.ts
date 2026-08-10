/**
 * Docker Compose install backend for `openship up`.
 *
 * The alternative to the "bare" process service (lib/service.ts): instead of
 * running the bundled API + downloaded dashboard as host processes (PGlite,
 * in-process jobs), bring up the published images as a compose stack —
 * postgres + redis + api + dashboard + the OpenResty `edge` container on
 * :80/:443. The api drives the edge + deployed app containers through the
 * mounted Docker socket (see OPENSHIP_EDGE_MODE=docker).
 *
 * Lifecycle (up/stop/update/status) routes here when ~/.openship/install-method
 * is "compose"; otherwise the bare service backend handles it.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import {
  LocalExecutor,
  EDGE_CONTAINER_MOUNTS,
  EDGE_HOST_STATE_DIR,
  invalidateEdgeContainer,
  systemCatalog,
  type EnvironmentProfile,
} from "@repo/adapters";
import { sanitizeEdgeVhosts } from "@repo/adapters/proxy";
import { DEFAULT_IMAGE_REGISTRY } from "@repo/core";

import { OS_DIR } from "./paths";
import {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  resolvePorts,
  type ResolvedPorts,
} from "./ports";
import { readSourceInstall } from "./source-install";

/** Host side of the edge's routing mounts — one source of truth with the api. */
const EDGE_SITES_HOST_DIR = `${EDGE_HOST_STATE_DIR}/sites-enabled`;
const EDGE_ACME_HOST_DIR = `${EDGE_HOST_STATE_DIR}/acme`;

/**
 * The edge's bind mounts as compose YAML lines.
 *
 * Generated from `EDGE_CONTAINER_MOUNTS` — the same array `buildEdgeRunCommand`
 * uses — because this list was previously hand-written here TWICE (api + edge) with
 * the container paths as literals. Adding a mount to the array then silently reached
 * `docker run` installs and not compose ones, which is the kind of divergence that
 * shows up as one install mode serving nothing.
 *
 * `:z` relabels for SELinux-enforcing hosts; a no-op elsewhere.
 */
function edgeVolumeYaml(indent: string): string {
  return EDGE_CONTAINER_MOUNTS.map((m) => `${indent}- ${m.host}:${m.container}:z`).join("\n");
}

declare const __CLI_VERSION__: string;

const COMPOSE_DIR = join(OS_DIR, "compose");
const INSTALL_METHOD_FILE = join(OS_DIR, "install-method");
const COMPOSE_FILE = join(COMPOSE_DIR, "docker-compose.yml");
/** From-source override: BUILDs api/dashboard/edge instead of pulling them. */
const BUILD_FILE = join(COMPOSE_DIR, "docker-compose.build.yml");
const ENV_FILE = join(COMPOSE_DIR, ".env");

/** Images the stack builds from source in a dev install; the rest (postgres,
 *  redis) are upstream and always pulled. */
const BUILT_SERVICES = [
  { service: "api", dockerfile: "apps/api/Dockerfile" },
  { service: "dashboard", dockerfile: "apps/dashboard/Dockerfile" },
  { service: "edge", dockerfile: "apps/edge/Dockerfile" },
] as const;

/**
 * Services whose BEHAVIOUR comes from `.env` (via `env_file:`), so a changed env
 * only reaches them on recreate. postgres/redis are deliberately excluded: they
 * read only credentials, which `keepSecret` never rotates, and recreating them
 * for an unrelated config change is downtime for nothing.
 */
const ENV_CONSUMING_SERVICES = ["api", "dashboard", "edge"] as const;

export type InstallMethod = "compose" | "bare";

export function readInstallMethod(): InstallMethod | null {
  try {
    const v = readFileSync(INSTALL_METHOD_FILE, "utf8").trim();
    return v === "compose" || v === "bare" ? v : null;
  } catch {
    return null;
  }
}

function writeInstallMethod(method: InstallMethod): void {
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(INSTALL_METHOD_FILE, method, { mode: 0o600 });
}

/**
 * Why Docker isn't usable, as three SEPARATE facts.
 *
 * Collapsing them into one boolean is what made the wizard announce "Docker
 * isn't installed" on a box that had Docker but no Compose plugin (Debian's
 * `docker.io` package ships none) — and then re-run get.docker.com for a daemon
 * that was merely unreachable, which cannot help and rewrites the host's docker
 * repo config on the way.
 */
export interface DockerState {
  /** `docker` is on PATH. Client-only probe — never touches the socket. */
  binary: boolean;
  /** `docker compose` resolves (Compose v2 plugin). Also client-only. */
  plugin: boolean;
  /** The daemon answers US. False when it's stopped OR the socket denies this
   *  user (not in the `docker` group) — indistinguishable from here, so the
   *  hint below covers both. */
  daemon: boolean;
}

export function dockerState(): DockerState {
  const ok = (args: string[]) => spawnSync("docker", args, { stdio: "ignore" }).status === 0;
  // `docker --version` is the client; `docker version` (no dashes) contacts the
  // daemon and is the one that fails on a permission-denied socket.
  if (!ok(["--version"])) return { binary: false, plugin: false, daemon: false };
  return { binary: true, plugin: ok(["compose", "version"]), daemon: ok(["version"]) };
}

export interface DockerGap {
  /** One line, safe to show a user verbatim. */
  summary: string;
  /** True when running the Docker installer would actually close this gap. */
  installable: boolean;
  /** What the operator should do when we can't. */
  hint?: string;
}

/** null when Docker is fully usable. */
export function dockerGap(state: DockerState = dockerState()): DockerGap | null {
  if (!state.binary) {
    return { summary: "Docker isn't installed", installable: true };
  }
  if (!state.plugin) {
    return {
      summary: "Docker is installed but the Compose plugin (`docker compose`) is missing",
      installable: true,
    };
  }
  if (!state.daemon) {
    const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
    return {
      summary: "Docker is installed but its daemon isn't reachable",
      // Reinstalling changes nothing: a group change only applies to NEW logins,
      // and a stopped daemon needs starting, not installing.
      installable: false,
      hint: asRoot
        ? "Start it with: systemctl start docker"
        : `Add your user to the docker group: sudo usermod -aG docker ${userInfo().username} — then log out and back in (or run: newgrp docker). If the daemon is stopped: sudo systemctl start docker`,
    };
  }
  return null;
}

/** docker + `docker compose` present AND the daemon reachable. */
export function hasDockerCompose(): boolean {
  return dockerGap() === null;
}

/** `cmd` is on PATH (probes `cmd --version`). */
function hasCmd(cmd: string): boolean {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Single-quote a string for `sh -c`. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface EnsureDockerOpts {
  /** Where narration goes. Defaults to stderr; the wizard passes clack's log so
   *  the lines match the rest of its output. */
  onNotice?: (line: string) => void;
}

/** What a Docker install would look like here — see `dockerInstallPreview`. */
export interface DockerInstallPreview {
  state: DockerState;
  /** Why Docker isn't usable; null when it already is. */
  gap: DockerGap | null;
  /** True when a real run would execute `installCommand` on this box. */
  wouldInstall: boolean;
  /** The exact installer command (get.docker.com), when there is one to run. */
  installCommand?: string;
  /** Best-effort daemon start that follows the install. */
  startCommand?: string;
}

/**
 * What `ensureDocker` WOULD do on this box, without doing any of it.
 *
 * `--dry-run` is why this exists: calling `ensureDocker` merely to find out
 * whether Docker was needed installed ~150 MB of packages and enabled a system
 * daemon on the machine the operator was only previewing (#436). `ensureDocker`
 * is implemented on top of this, so the preview and the run can't disagree about
 * whether an install happens or which command performs it.
 */
export function dockerInstallPreview(state: DockerState = dockerState()): DockerInstallPreview {
  const gap = dockerGap(state);
  if (!gap) return { state, gap: null, wouldInstall: false };
  // Docker Desktop can't be installed unattended, and an unreachable daemon is
  // not an installation problem (see dockerGap) — neither runs the installer.
  if (process.platform !== "linux" || !gap.installable) return { state, gap, wouldInstall: false };
  const plan = systemCatalog.installs.docker({
    os: "linux",
    serviceManager: "systemd",
  } as unknown as EnvironmentProfile);
  if (!plan.supported || !plan.installCommand) return { state, gap, wouldInstall: false };
  return {
    state,
    gap,
    wouldInstall: true,
    installCommand: plan.installCommand,
    ...(plan.startCommand ? { startCommand: plan.startCommand } : {}),
  };
}

/**
 * Ensure Docker + Compose are usable, auto-installing Docker if missing. Reuses
 * the SAME install command the deploy pipeline uses to provision target servers
 * (`systemCatalog.installs.docker` → get.docker.com), so there's one definition
 * of "how we install Docker". Returns true once `docker compose` works.
 *
 * Only attempts on Linux — Docker Desktop on macOS/Windows can't be installed
 * unattended (and its edge container lacks host networking), so those return
 * false and the caller falls back to the bare service. The installer's own
 * output is inherited (that's the real progress the operator sees).
 *
 * MUTATES the box. Anything that only needs to know WHETHER it would install
 * (`--dry-run`) must call `dockerInstallPreview` instead.
 */
export async function ensureDocker(opts: EnsureDockerOpts = {}): Promise<boolean> {
  const notice = opts.onNotice ?? ((line: string) => process.stderr.write(`  ${line}\n`));
  const { state, gap, wouldInstall, installCommand, startCommand } = dockerInstallPreview();
  if (!gap) return true;
  if (process.platform !== "linux") return false;
  // An unreachable daemon is not an installation problem — say what to do and
  // stop, rather than running the Docker installer over a working install.
  if (!gap.installable) {
    notice(gap.summary + ".");
    if (gap.hint) notice(gap.hint);
    return false;
  }
  if (!wouldInstall || !installCommand) return false;

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const sudo = !asRoot && hasCmd("sudo") ? "sudo " : "";

  // Set expectations BEFORE the child takes over the terminal. get.docker.com
  // prints its commit line and then goes quiet for minutes while apt fetches
  // ~150 MB — on a small VPS that silence reads as a hang, and operators kill it.
  notice("This can take 2-5 minutes on a small VPS (~150 MB of packages) and stays quiet while apt works.");
  if (state.binary) {
    // The installer detects the existing docker, prints a scary-looking warning
    // and then `sleep 20` before continuing. Pre-empt it or the pause looks broken.
    notice("Docker's installer will warn that docker already exists and pause ~20s before continuing — that's expected.");
  }

  const sh = (script: string): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn("sh", ["-c", sudo ? `${sudo}sh -c ${shQuote(script)}` : script], {
        stdio: "inherit",
      });
      // Heartbeat: the ONLY output during the long apt phase, so an operator can
      // tell "still working" from "wedged". spawn (not spawnSync) purely so this
      // timer can fire — a sync child blocks the event loop and prints nothing.
      const started = Date.now();
      const tick = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        notice(`still installing Docker — ${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s elapsed…`);
      }, 30_000);
      const done = (code: number) => {
        clearInterval(tick);
        resolve(code);
      };
      child.on("error", () => done(1));
      child.on("close", (code) => done(code ?? 1));
    });

  if ((await sh(installCommand)) !== 0) return false;
  // Best-effort daemon start (get.docker.com already enables it on systemd).
  if (startCommand) await sh(startCommand);

  const after = dockerGap();
  if (!after) {
    notice("Docker ready.");
    return true;
  }
  // Installed fine, still not usable — almost always the group: root installed
  // it, this (non-root) process still can't open the socket until a new login.
  notice(after.summary + ".");
  if (after.hint) notice(after.hint);
  return false;
}

export interface ComposeUpOpts {
  /** Don't give the api a channel to the HOST OS (no key, no mount, refuse ops). */
  noHostControl?: boolean;
  apiPort?: string;
  dashboardPort?: string;
  publicUrl?: string;
  /** Extra browser origins to trust (comma-separated), e.g. a LAN IP + a domain. */
  extraTrustedOrigins?: string;
  trustProxy?: boolean;
  registry?: string;
  version?: string;
  /** Force the pull path even on a from-source install (escape hatch). */
  build?: boolean;
  /**
   * `composePrefetch` already pulled/built in THIS run, so skip straight to the
   * swap. Not an optimisation: every second between the operator's proxy stopping
   * and our edge binding is downtime, and a cached re-pull/re-build still costs
   * seconds (and a registry round-trip that can hang).
   */
  alreadyFetched?: boolean;
}

/** Pinned compose stack. Vars come from the generated .env (env_file + interpolation). */
const COMPOSE_YAML = `# Managed by \`openship up\` — do not edit; re-run \`openship up\` to regenerate.
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      # Keep the data dir in a subdirectory of the volume so a fresh install never
      # runs initdb against a bare mount root (which fails on quirky host
      # filesystems with EPERM — #350). OPENSHIP_PGDATA is decided ONCE at install
      # by the CLI (fresh → subdir, pre-existing volume → root) and preserved in
      # .env, so this never moves an existing database.
      PGDATA: \${OPENSHIP_PGDATA:-/var/lib/postgresql/data/pgdata}
      POSTGRES_USER: \${POSTGRES_USER:-openship}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?missing from .env — re-run openship up to regenerate it}
      POSTGRES_DB: \${POSTGRES_DB:-openship}
    expose: ["5432"]
    volumes: [postgres_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-openship} -d \${POSTGRES_DB:-openship}"]
      interval: 5s
      timeout: 3s
      retries: 12

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    expose: ["6379"]
    volumes: [redis_data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 12

  api:
    image: \${OPENSHIP_IMAGE_REGISTRY:-ghcr.io/oblien}/openship-api:\${OPENSHIP_VERSION:-latest}
    restart: unless-stopped
    # Loopback by default — the host-net edge reaches it over loopback, so nothing
    # sits on a public interface. OPENSHIP_BIND_ADDR opts into a public/LAN interface
    # (set by \`openship up\` when a public URL is configured for off-box access).
    ports: ["\${OPENSHIP_BIND_ADDR:-127.0.0.1}:\${API_PORT:-4000}:\${API_PORT:-4000}"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # Routing state shared with the edge, as HOST BIND MOUNTS (generated from
      # EDGE_CONTAINER_MOUNTS): the vhost tree, /etc/letsencrypt, the ACME webroot
      # and the static doc-roots the API writes and the edge serves. Named volumes
      # hid all of it from every host-side reader (migrate's proxy scan, cert carry,
      # cert reuse, mail cert symlinks), each of which then silently saw "nothing".
${edgeVolumeYaml("      ")}
      # Host-op SSH key (createHostExecutor → host.docker.internal). /dev/null
      # when the host channel isn't provisioned → OPENSHIP_HOST_SSH_HOST stays
      # unset and the API falls back to LocalExecutor.
      - \${OPENSHIP_HOST_KEY_PATH:-/dev/null}:/run/secrets/openship_host_key:ro
    extra_hosts: ["host.docker.internal:host-gateway"]
    env_file: [.env]
    environment:
      NODE_ENV: production
      PORT: "\${API_PORT:-4000}"
      DATABASE_URL: postgresql://\${POSTGRES_USER:-openship}:\${POSTGRES_PASSWORD:?missing from .env — re-run openship up to regenerate it}@postgres:5432/\${POSTGRES_DB:-openship}
      REDIS_URL: redis://redis:6379
      OPENSHIP_EDGE_MODE: docker
      OPENSHIP_EDGE_CONTAINER: openship-edge
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "bun -e \\"fetch('http://127.0.0.1:\${API_PORT:-4000}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\\""]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 40s

  dashboard:
    image: \${OPENSHIP_IMAGE_REGISTRY:-ghcr.io/oblien}/openship-dashboard:\${OPENSHIP_VERSION:-latest}
    restart: unless-stopped
    # Loopback by default (see api note); OPENSHIP_BIND_ADDR opts into a public interface.
    ports: ["\${OPENSHIP_BIND_ADDR:-127.0.0.1}:\${DASHBOARD_PORT:-3001}:\${DASHBOARD_PORT:-3001}"]
    env_file: [.env]
    environment:
      NODE_ENV: production
      PORT: "\${DASHBOARD_PORT:-3001}"
      INTERNAL_API_URL: http://api:\${API_PORT:-4000}
    depends_on:
      api: { condition: service_healthy }

  edge:
    image: \${OPENSHIP_IMAGE_REGISTRY:-ghcr.io/oblien}/openship-edge:\${OPENSHIP_VERSION:-latest}
    # PINNED, and it must stay pinned: the api reaches the edge by NAME through
    # DockerEdgeExecutor (OPENSHIP_EDGE_CONTAINER above), and "ours" edge
    # detection greps \`docker ps --filter name=openship-edge\`. Without this,
    # compose derives \`<project>-edge-1\` from the directory and every
    # \`docker exec\` into the edge fails with "No such container: openship-edge" —
    # which silently migrated 0 sites after the operator's proxy was stopped.
    # Safe here: the edge is a singleton (host networking, one per box).
    container_name: openship-edge
    restart: unless-stopped
    network_mode: host
    volumes:
${edgeVolumeYaml("      ")}

volumes:
  postgres_data:
  redis_data:
`;

/** Persist a stable secret in the compose .env — regenerated only if absent. */
function keepSecret(existing: Record<string, string>, key: string): string {
  return existing[key] || randomBytes(32).toString("hex");
}

/** Parse the existing .env so re-running `up` preserves generated secrets. */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* first run */
  }
  return out;
}

/**
 * Provision the container→host SSH channel so the api container can run HOST-OS
 * ops (free a foreign proxy off :80/:443, host config) via createHostExecutor —
 * exactly what a bare install does locally. Best-effort + idempotent: generates
 * an ed25519 key under the compose dir, authorizes it for the invoking host user,
 * and returns (user, keyPath) for the .env + volume mount. Returns null on any
 * failure or non-Linux → OPENSHIP_HOST_SSH_* stays unset and createHostExecutor
 * cleanly falls back to LocalExecutor (no host channel; never breaks `up`).
 *
 * Not a new privilege: the api container already holds host-root-equivalent
 * access through the mounted docker socket — this key just gives it a shell for
 * the host ops the socket can't do. Prereq: the host runs sshd reachable from
 * containers on host.docker.internal:22.
 */
/** Marks the authorized_keys line as ours, so re-runs can revoke the previous one. */
const HOST_KEY_COMMENT = "openship-host-executor";

/**
 * Source addresses allowed to use the host-executor key.
 *
 * The container reaches the host over the docker bridge gateway
 * (`host.docker.internal:host-gateway`), so every legitimate use of this key comes
 * from RFC1918 space. Without a `from=` restriction the key is a general-purpose
 * login for this user from ANY address sshd accepts — on a VPS, the whole internet.
 * That is a materially bigger blast radius than the docker socket this channel is
 * justified against: the socket is only reachable from inside the container, while
 * an unrestricted key works from anywhere the private half turns up.
 */
const HOST_KEY_FROM = "172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1";

/**
 * The authorized_keys line for our public key.
 *
 * `restrict` (OpenSSH 7.2+) denies port forwarding, agent forwarding, X11 and user
 * rc, and is fail-closed: capabilities OpenSSH adds later stay off unless named
 * here. The no-forwarding part is what matters most — it stops a leaked key from
 * being turned into a tunnel into other services bound on the host.
 *
 * `pty` is added back deliberately: `restrict` also implies `no-pty`, and the host
 * terminal (`SshExecutor.openShell` → `client.shell({ term, cols, rows })`) needs
 * one. It costs nothing in privilege — the key already grants command execution, so
 * a pty only changes how that execution is framed, not what it can do.
 */
function hostKeyAuthLine(pub: string): string {
  return `from="${HOST_KEY_FROM}",restrict,pty ${pub}`;
}

/**
 * PURE. The new contents of `authorized_keys` with our host-executor key present
 * exactly once, restricted, and every earlier openship line revoked.
 *
 * Revoking matters twice over. An install whose key dir was wiped (a re-run after
 * `rm -rf ~/.openship`) used to leave the OLD public key authorized forever — a
 * credential no amount of re-running could take back. And an install predating the
 * `from=`/`restrict` hardening would keep its unrestricted line alongside the new
 * one, so sshd would still honour the wide grant and the hardening would be purely
 * cosmetic. Lines the operator added themselves are matched by neither rule and are
 * preserved untouched.
 *
 * Exported for tests: this is security-relevant string surgery on a file that
 * governs who can log into the box, so it's verified directly rather than inferred.
 */
export function rewriteHostAuthorizedKeys(existing: string, pub: string): string {
  const kept = existing
    .split("\n")
    .filter((line) => line.trim() && !line.includes(HOST_KEY_COMMENT));
  return [...kept, hostKeyAuthLine(pub)].join("\n") + "\n";
}

/**
 * The container→host SSH channel a run WOULD use: where its key lives and which
 * host user it logs in as — or null when there won't be one (`--no-host-control`,
 * or a non-Linux box: host.docker.internal SSH is the Linux compose path).
 *
 * THE rule, and pure. `provisionHostSshChannel` creates what this names, and
 * `composePlan` previews it, so a dry run can't describe a channel the install
 * wouldn't provision (or miss one it would).
 */
function plannedHostChannel(hostControl: boolean): { user: string; keyPath: string } | null {
  if (!hostControl || process.platform !== "linux") return null;
  // `userInfo()` rather than $USER: os.homedir() and $USER can disagree under sudo
  // (HOME=/root with USER preserved, or vice versa), which would write the key into
  // one account's authorized_keys while telling the container to log in as another —
  // host ops then fail with a bare "auth failed". userInfo() is the same passwd
  // entry homedir() resolves from, so the two can't drift.
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER || process.env.LOGNAME || "root";
  }
  return { user, keyPath: join(COMPOSE_DIR, "host-ssh", "id_ed25519") };
}

function provisionHostSshChannel(hostControl: boolean): { user: string; keyPath: string } | null {
  const target = plannedHostChannel(hostControl);
  if (!target) return null;
  const { user, keyPath } = target;
  try {
    mkdirSync(join(COMPOSE_DIR, "host-ssh"), { recursive: true, mode: 0o700 });
    if (!existsSync(keyPath)) {
      const g = spawnSync(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-q", "-f", keyPath, "-C", HOST_KEY_COMMENT],
        { stdio: "ignore" },
      );
      if (g.status !== 0) return null;
    }
    const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
    if (!pub) return null;

    // Authorize the key for the host user the container SSHes in as (see
    // plannedHostChannel for why that user comes from the passwd entry).
    const userSshDir = join(homedir(), ".ssh");
    mkdirSync(userSshDir, { recursive: true, mode: 0o700 });
    const authKeys = join(userSshDir, "authorized_keys");
    const existing = existsSync(authKeys) ? readFileSync(authKeys, "utf8") : "";
    const next = rewriteHostAuthorizedKeys(existing, pub);
    if (next !== existing) writeFileSync(authKeys, next, { mode: 0o600 });
    // mode: on writeFileSync only applies at CREATE, so an authorized_keys that
    // already existed keeps its old permissions — set them explicitly.
    chmodSync(authKeys, 0o600);

    return { user, keyPath };
  } catch {
    return null;
  }
}

/**
 * The compose project name — the prefix on every container, volume and network.
 *
 * Unset, compose derives it from the project DIRECTORY (`~/.openship/compose`),
 * which is why the stack read `compose-api-1` / `compose_postgres_data` instead of
 * naming itself. Pinned to `openship` so it does.
 *
 * But the project name is also the volume prefix, so changing it on a LIVE install
 * would repoint `postgres_data` and `certs` at fresh empty volumes — the database
 * and issued certificates would look wiped (they'd still be on disk under the old
 * prefix, but nothing would mount them). So: an install that already has a `.env`
 * without this key predates the pin and keeps its directory-derived `compose` name;
 * only fresh installs get `openship`. Docker Compose reads COMPOSE_PROJECT_NAME
 * from the project dir's .env, so pinning it here needs no flag at the call site.
 */
function composeProjectName(prev: Record<string, string>): string {
  if (prev.COMPOSE_PROJECT_NAME) return prev.COMPOSE_PROJECT_NAME;
  return Object.keys(prev).length > 0 ? "compose" : "openship";
}

/**
 * Where Postgres keeps its data directory INSIDE the `postgres_data` volume.
 *
 * A fresh install uses a subdirectory (`…/data/pgdata`) rather than the bare
 * mount root: initdb against a mount root fails on quirky host filesystems with
 * "Operation not permitted" (WAL preallocation / lost+found — see #350). But a
 * pre-existing install already has its DB at the mount ROOT, and moving PGDATA
 * would make Postgres init a fresh empty DB and orphan the old one. So the
 * decision is made ONCE and then pinned in `.env` (same sticky rule as
 * COMPOSE_PROJECT_NAME): re-runs reuse it; a volume that predates this pin keeps
 * the root. The check uses the resolved project name so it inspects the right
 * `<project>_postgres_data` volume.
 */
const PGDATA_ROOT = "/var/lib/postgresql/data";
function resolvePgData(prev: Record<string, string>): string {
  if (prev.OPENSHIP_PGDATA) return prev.OPENSHIP_PGDATA; // decided already — never move it
  return dbVolumeExists(composeProjectName(prev)) ? PGDATA_ROOT : `${PGDATA_ROOT}/pgdata`;
}

/**
 * Containers from a PREVIOUS run of this same compose file that are now orphaned
 * under a different project name.
 *
 * Renaming the compose project (or letting it be derived from the directory)
 * starts a SECOND stack rather than replacing the first. The old `edge` keeps
 * :80/:443 — it is host-networked — so the new edge crashloops on
 * `bind() … Address already in use`, and the old edge serves vhosts out of the
 * old project's volume while the api writes them into the new one. Net effect:
 * everything reports "Deployed" and nothing is served.
 *
 * Identified by compose's own `project.config_files` label pointing at OUR
 * compose file, so this can never match an unrelated stack that happens to have a
 * service called `edge` — and by construction it only ever lists containers a
 * previous `openship up` created. Volumes are deliberately NOT touched: they hold
 * the database and issued certificates.
 */
function orphanedStackContainers(project: string): Array<{ name: string; project: string }> {
  const r = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--format",
      '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.config_files"}}',
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, proj, configFiles] = line.split("\t");
      return { name: name ?? "", project: proj ?? "", configFiles: configFiles ?? "" };
    })
    .filter(
      (c) =>
        c.name &&
        c.project &&
        c.project !== project &&
        // config_files is a comma-separated list (base + build override).
        c.configFiles.split(",").some((f) => f.trim() === COMPOSE_FILE),
    )
    .map(({ name, project: proj }) => ({ name, project: proj }));
}

/**
 * Reconcile the DB password against a data volume that PREDATES this `.env`.
 *
 * Postgres only applies `POSTGRES_PASSWORD` when it initializes an EMPTY data
 * dir. So an install that regenerated its secrets (a wiped `~/.openship`, a
 * restored backup, a manually deleted `.env`) while `<project>_postgres_data`
 * survived leaves the volume on the OLD password and the api presenting the new
 * one — the api then crash-loops on `password authentication failed for user`
 * (28P01) and compose reports only "dependency failed to start", which points at
 * the wrong thing entirely.
 *
 * Fix it where the authority is: bring postgres up alone, set the role's password
 * to what this `.env` says (over the container's trusted local socket, so no
 * password is needed to do it), then let the rest of the stack start. Idempotent —
 * on a normal run the password already matches and this is a no-op ALTER.
 */
function reconcileDbPassword(user: string, password: string): void {
  if (!password) return;
  // Postgres must be RUNNING to accept the ALTER, and healthy before the api
  // needs it — bring up just this one service first.
  if (compose(["up", "-d", "--wait", "postgres"], { quiet: true }) !== 0) return;

  // Try as the configured role, then as `postgres`. The second attempt is not
  // redundant: a volume initialized under a DIFFERENT POSTGRES_USER has no such
  // role, so `psql -U <user>` fails before the ALTER is ever parsed. The image's
  // pg_hba trusts local socket connections, so both work without a password —
  // which is the only reason we can fix an install whose password we don't know.
  const attempt = (asRole: string) =>
    spawnSync(
      "docker",
      [
        "compose",
        "-f",
        COMPOSE_FILE,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        asRole,
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        // Read the statement from STDIN, not `-c`: psql has no bind parameters for
        // ALTER USER, so the password has to be inlined in SQL — and an argv copy
        // would be readable in `ps` for the life of the call. stdin keeps it to this
        // process and the socket. Our generated password is hex, so it cannot break
        // out of the quoted literal either.
        "-f",
        "-",
      ],
      {
        cwd: COMPOSE_DIR,
        encoding: "utf8",
        // Create the role if the volume predates it, else just realign it. Both
        // branches leave exactly the credentials this `.env` will present.
        input:
          `DO $$ BEGIN\n` +
          `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN\n` +
          `    ALTER ROLE "${user}" WITH LOGIN PASSWORD '${password}';\n` +
          `  ELSE\n` +
          `    CREATE ROLE "${user}" WITH LOGIN SUPERUSER PASSWORD '${password}';\n` +
          `  END IF;\n` +
          `END $$;\n`,
      },
    );

  let r = attempt(user);
  if (r.status !== 0) r = attempt("postgres");
  if (r.status !== 0) {
    // Loud, not a footnote: with the gate removed this is the ONE thing standing
    // between a surviving volume and an api that crash-loops on 28P01 behind a
    // compose message that blames "dependency failed to start".
    console.log(
      `\n  ! Could not realign the database password (${(r.stderr ?? "").trim() || "psql failed"}).\n` +
        `    The api will fail with "password authentication failed for user \"${user}\"" because the\n` +
        `    existing data volume was initialized with a different password.\n\n` +
        `    Fix it one of two ways:\n` +
        `      • restore the .env that created the volume, or\n` +
        `      • start fresh (DESTROYS DB DATA):  openship uninstall  then  openship up\n`,
    );
  }
}

/** Remove orphaned containers from a previous project so the new stack can bind. */
function removeOrphanedStack(project: string): void {
  const orphans = orphanedStackContainers(project);
  if (orphans.length === 0) return;
  const projects = [...new Set(orphans.map((o) => o.project))].join(", ");
  console.log(
    `  Removing ${orphans.length} container(s) from a previous stack (project "${projects}") — ` +
      `they would hold the ports this stack needs. Volumes are kept.`,
  );
  spawnSync("docker", ["rm", "-f", ...orphans.map((o) => o.name)], { stdio: "ignore" });
}

/**
 * Clear a stray `openship-edge` that THIS compose project doesn't own, so `up`
 * can create its own.
 *
 * The edge is the one service pinned to a fixed `container_name` (everything else
 * reaches it by name — `OPENSHIP_EDGE_CONTAINER`, the `docker ps --filter
 * name=openship-edge` detection, `docker exec`), and a fixed name is a collision
 * hazard: compose only ever recreates a container it LABELS as its own, so a
 * container called `openship-edge` left by any other owner makes `up` abort with
 * "the container name is already in use". `removeOrphanedStack` can't reach it —
 * that matches our exact `config_files` label, so a foreign-project edge, a
 * from-source `docker/docker-compose.yml` edge, or a label-less `docker run` edge
 * (an edge takeover that never went through compose) all slip past. This closes
 * that gap for the one name that can hit it.
 *
 * Unconditionally safe: the edge is stateless — every byte of vhost + cert config
 * lives in the host bind mounts, not the container — so a removed edge recreated by
 * `up` moments later serves exactly the same sites. Left alone when compose already
 * owns it (same project + our compose file), where `up` recreates it cleanly.
 */
const EDGE_SWEEP_FORMAT =
  '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.config_files"}}';

/**
 * From a `docker ps -a` sweep (name\tproject\tconfig_files rows), whether a stray
 * `openship-edge` must be force-removed before `up`: it exists AND is not owned by
 * THIS compose project (same project name AND our compose file among the config
 * files). No such row → false. Pure, so the decision is unit-tested directly.
 */
export function edgeNameNeedsReclaim(psStdout: string, project: string): boolean {
  const row = psStdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.split("\t")[0] === "openship-edge");
  if (!row) return false; // no such container — nothing in the way
  const [, proj = "", configFiles = ""] = row.split("\t");
  const ours =
    proj === project && configFiles.split(",").some((f) => f.trim() === COMPOSE_FILE);
  return !ours;
}

function reconcileEdgeContainerName(project: string): void {
  const r = spawnSync("docker", ["ps", "-a", "--format", EDGE_SWEEP_FORMAT], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return;
  if (!edgeNameNeedsReclaim(r.stdout, project)) return;
  console.log(
    "  Replacing an unmanaged `openship-edge` container so compose can own it (config is on the host, so no routes are lost).",
  );
  spawnSync("docker", ["rm", "-f", "openship-edge"], { stdio: "ignore" });
}

/**
 * Move edge state out of the legacy Docker-managed volumes onto the host.
 *
 * Installs before this change kept vhosts, certs, the ACME webroot and static
 * doc-roots in named volumes mounted only into the api + edge containers. The host
 * could not see any of it, which silently broke every host-side reader — the
 * migrate wizard's domain/SSL detection, migration cert carry, cert reuse, the mail
 * server's cert symlinks. The stack now bind-mounts canonical host paths, so
 * anything still in a legacy volume has to be copied across or the box comes back
 * up with no certs and no routes.
 *
 * Copy-only, never a move: the volumes stay on disk untouched, so this is
 * reversible and re-runnable. Skipped per-path once the host side is non-empty.
 */
function migrateLegacyEdgeVolumes(project: string): void {
  const pairs = [
    { volume: `${project}_openship_sites`, host: EDGE_SITES_HOST_DIR },
    { volume: `${project}_openship_certs`, host: "/etc/letsencrypt" },
    { volume: `${project}_openship_acme`, host: EDGE_ACME_HOST_DIR },
    { volume: `${project}_openship_static`, host: "/opt/openship/static" },
  ];
  const ls = spawnSync("docker", ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf8" });
  if (ls.status !== 0 || !ls.stdout) return;
  const existing = new Set(ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean));

  for (const { volume, host } of pairs) {
    if (!existing.has(volume)) continue;
    mkdirSync(host, { recursive: true });
    // Only when the host side is still empty — a second `up` must not clobber
    // certs the containerized edge has since renewed in place.
    const alreadyThere = spawnSync("sh", ["-c", `ls -A ${JSON.stringify(host)} 2>/dev/null | head -1`], {
      encoding: "utf8",
    });
    if (alreadyThere.stdout?.trim()) continue;
    console.log(`  Moving edge state from volume ${volume} onto ${host}...`);
    // A throwaway container is the only way to read a named volume's contents;
    // `cp -a` preserves the symlink farm certbot builds under live/.
    const copy = spawnSync(
      "docker",
      [
        "run", "--rm",
        "-v", `${volume}:/from:ro`,
        "-v", `${host}:/to`,
        "alpine:3", "sh", "-c", "cp -a /from/. /to/ 2>/dev/null || true",
      ],
      { stdio: "inherit" },
    );
    if (copy.status !== 0) {
      console.log(
        `  Could not copy ${volume} — the stack will start with an empty ${host}.\n` +
          `  Recover manually with: docker run --rm -v ${volume}:/from -v ${host}:/to alpine cp -a /from/. /to/`,
      );
    }
  }
}

/**
 * Warn when a previous project's data volumes exist but won't be mounted, so a
 * project-name change can never look like silent data loss. Legacy installs
 * declared the volume key `openship_sites`, so any `<project>_openship_sites`
 * names a prior stack of ours.
 */
function warnOrphanedVolumes(project: string): void {
  const r = spawnSync("docker", ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return;
  const others = new Set(
    r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith("_openship_sites"))
      .map((l) => l.slice(0, -"_openship_sites".length))
      .filter((p) => p && p !== project),
  );
  if (others.size === 0) return;
  console.log(
    `  Note: volumes from a previous install (project "${[...others].join(", ")}") are still on disk\n` +
      `  and are NOT mounted by this stack — its database starts fresh. (Certificates and\n` +
      `  vhosts now live on the host, so those carry over.)\n` +
      `  Remove them with \`docker volume ls | grep _openship_\` once you're sure they aren't needed.`,
  );
}

/**
 * Operator configuration that must SURVIVE a plain re-run.
 *
 * `openship up` regenerates `.env` from scratch, so anything it doesn't write is
 * gone. That made a bare `openship up` (the natural thing to do after
 * `openship update`) silently drop the public URL — and `OPENSHIP_PUBLIC_URL` is
 * what puts the operator's domain in the API's `trustedOrigins`. The stack came
 * back up serving reads fine and 403ing every mutation with
 * `ORIGIN_REJECTED`, which points at neither the cause nor the fix.
 *
 * So: an explicit flag wins, otherwise the previous value is carried forward,
 * otherwise the default. Re-running `up` with no flags is now a no-op on config,
 * which is what everyone already assumed it was.
 */
function keepConfig(
  prev: Record<string, string>,
  key: string,
  explicit?: string | null,
): string | undefined {
  const set = explicit?.trim();
  if (set) return set;
  const carried = prev[key]?.trim();
  return carried || undefined;
}

const ACME_ENV_KEYS = [
  "OPENSHIP_ACME_EMAIL",
  "OPENSHIP_ACME_DIRECTORY_URL",
  "OPENSHIP_ACME_EAB_KID",
  "OPENSHIP_ACME_EAB_HMAC_KEY",
  "OPENSHIP_ACME_KEY_TYPE",
  "OPENSHIP_ACME_CA_BUNDLE",
  "OPENSHIP_ACME_TOS_AGREED",
] as const;

/** Preserve operator-owned ACME settings, with the current shell overriding .env. */
function renderAcmeEnv(prev: Record<string, string>): string[] {
  return ACME_ENV_KEYS.flatMap((key) => {
    const value = process.env[key]?.trim() || prev[key]?.trim();
    if (!value) return [];
    if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single-line value`);
    return [`${key}=${value}`];
  });
}

/** The effective config for this run: flags over previous `.env` over defaults. */
export function resolveEnvConfig(
  prev: Record<string, string>,
  opts: ComposeUpOpts,
): {
  apiPort: string;
  dashPort: string;
  /** Interface the api + dashboard ports are published on; undefined = all. */
  bindAddr?: string;
  publicUrl?: string;
  trustProxy: boolean;
  extraTrustedOrigins?: string;
  registry: string;
  hostControl: boolean;
} {
  const publicUrl = keepConfig(prev, "OPENSHIP_PUBLIC_URL", opts.publicUrl);
  // Bind interface. An explicit setting always wins and is carried across re-runs
  // (an operator who pinned one interface made a security decision; regenerating
  // `.env` without it must not silently republish the api + dashboard everywhere).
  // With nothing pinned we default by EXPOSURE, not to 0.0.0.0 blindly:
  //   • public URL configured → the box is meant to be reachable off-host, so
  //     publish on all interfaces (matches prior behavior; never breaks a remote
  //     install whose `.env` predates this key or that is reached by IP:port).
  //   • no public URL (a local / same-host install) → leave it unset so the
  //     compose loopback default (${OPENSHIP_BIND_ADDR:-127.0.0.1}) applies and the
  //     ports never touch a public interface. The host-net edge still fronts any
  //     domains over loopback, so a domain-fronted box can also pin 127.0.0.1.
  const bindAddr = keepConfig(prev, "OPENSHIP_BIND_ADDR") ?? (publicUrl ? "0.0.0.0" : undefined);
  return {
    apiPort: keepConfig(prev, "API_PORT", opts.apiPort) ?? String(DEFAULT_API_PORT),
    dashPort: keepConfig(prev, "DASHBOARD_PORT", opts.dashboardPort) ?? String(DEFAULT_DASHBOARD_PORT),
    ...(bindAddr ? { bindAddr } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    // A public URL always implies a proxy in front; otherwise keep whatever the
    // install was configured with.
    trustProxy: Boolean(opts.trustProxy) || Boolean(publicUrl) || prev.TRUST_PROXY === "true",
    ...(keepConfig(prev, "OPENSHIP_EXTRA_TRUSTED_ORIGINS", opts.extraTrustedOrigins)
      ? {
          extraTrustedOrigins: keepConfig(
            prev,
            "OPENSHIP_EXTRA_TRUSTED_ORIGINS",
            opts.extraTrustedOrigins,
          ),
        }
      : {}),
    registry: keepConfig(prev, "OPENSHIP_IMAGE_REGISTRY", opts.registry) ?? DEFAULT_IMAGE_REGISTRY,
    // Tri-state: the flag is absent on a plain re-run, so fall back to what the
    // install chose rather than silently re-granting host control.
    hostControl:
      opts.noHostControl === undefined ? prev.OPENSHIP_HOST_CONTROL !== "false" : !opts.noHostControl,
  };
}

/** A usable TCP port, or undefined for anything that isn't one. */
function toPort(value?: string): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

/** The ports the live install is configured with (its `.env`), if any. */
export function composeEnvPorts(): { api?: number; dashboard?: number } {
  const env = readEnvFile();
  return { api: toPort(env.API_PORT), dashboard: toPort(env.DASHBOARD_PORT) };
}

/** The interface the stack publishes the api + dashboard on (compose default). */
export function composeBindAddr(): string {
  // Match the compose template fallback (${OPENSHIP_BIND_ADDR:-127.0.0.1}): when
  // `.env` pins no interface the ports bind loopback, so port-conflict probing
  // must check loopback too, not the whole box.
  return readEnvFile().OPENSHIP_BIND_ADDR?.trim() || "127.0.0.1";
}

/**
 * The trusted-origin URLs this install is configured with, so a caller can check
 * them against a port that just moved (see `stalePortOrigins`).
 */
export function composeTrustedOriginUrls(): string[] {
  const env = readEnvFile();
  return [env.OPENSHIP_PUBLIC_URL, env.OPENSHIP_EXTRA_TRUSTED_ORIGINS].filter(
    (v): v is string => !!v?.trim(),
  );
}

/**
 * Host ports currently published by containers belonging to THIS stack — the ones
 * a port probe would call occupied even though this command is what frees them.
 *
 * Matched on the compose config-file label rather than the project name, so it
 * covers both our own project and an ORPHANED one (a stack from a renamed
 * project, which `removeOrphanedStack` force-removes before `up` binds). Running
 * containers only: a stopped one holds nothing.
 */
export function composeHeldPorts(): number[] {
  const r = spawnSync(
    "docker",
    ["ps", "--format", '{{.Label "com.docker.compose.project.config_files"}}\t{{.Ports}}'],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return [];
  const ports = new Set<number>();
  for (const line of r.stdout.split("\n")) {
    const [configFiles = "", published = ""] = line.split("\t");
    if (!configFiles.split(",").some((f) => f.trim() === COMPOSE_FILE)) continue;
    // "0.0.0.0:4000->4000/tcp, [::]:4000->4000/tcp" — the host side is what binds.
    for (const m of published.matchAll(/:(\d+)->/g)) ports.add(Number(m[1]));
  }
  return [...ports];
}

/**
 * Resolve the stack's host ports before `.env` is written — the compose
 * counterpart of what the bare installer does with `resolvePorts`.
 *
 * `docker compose up` publishes API_PORT/DASHBOARD_PORT on the host, so an
 * occupied 4000/3001 is not a degraded install, it is a hard `bind: address
 * already in use` that takes the whole stack down with it. Probing on the
 * publish interface (0.0.0.0) and treating our own containers' ports as
 * reclaimable makes a busy box behave like the desktop app: pick another port and
 * carry on, while a plain re-run keeps the ports the install already uses.
 */
export async function resolveComposePorts(
  prefs: {
    api?: string;
    dashboard?: string;
  },
  opts: { persist?: boolean } = {},
): Promise<ResolvedPorts> {
  return resolvePorts(
    {
      api: toPort(prefs.api),
      dashboard: toPort(prefs.dashboard),
      previous: composeEnvPorts(),
      bindAddr: composeBindAddr(),
      reclaimable: composeHeldPorts(),
    },
    opts,
  );
}

function renderEnv(
  opts: ComposeUpOpts,
  host: { user: string; keyPath: string } | null,
  cfg: ReturnType<typeof resolveEnvConfig>,
): string {
  const prev = readEnvFile();
  const lines: string[] = [
    "# Managed by `openship up`. Secrets are generated once and preserved.",
    // Do NOT edit on a live install — it is the volume prefix (see composeProjectName).
    `COMPOSE_PROJECT_NAME=${composeProjectName(prev)}`,
    "CLOUD_MODE=false",
    "OPENSHIP_TARGET=local",
    "OPENSHIP_REQUIRE_AUTH=true",
    // Read by createHostExecutor (throws when false) and by the servers list
    // (hides the local row). Written explicitly so the policy is visible in .env.
    `OPENSHIP_HOST_CONTROL=${cfg.hostControl ? "true" : "false"}`,
    `OPENSHIP_IMAGE_REGISTRY=${cfg.registry}`,
    `OPENSHIP_VERSION=${opts.version || (typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "latest")}`,
    `POSTGRES_PASSWORD=${keepSecret(prev, "POSTGRES_PASSWORD")}`,
    // Pinned once (see resolvePgData): fresh install → subdir, existing volume → root.
    `OPENSHIP_PGDATA=${resolvePgData(prev)}`,
    `BETTER_AUTH_SECRET=${keepSecret(prev, "BETTER_AUTH_SECRET")}`,
    `INTERNAL_TOKEN=${keepSecret(prev, "INTERNAL_TOKEN")}`,
    `API_PORT=${cfg.apiPort}`,
    `DASHBOARD_PORT=${cfg.dashPort}`,
    // The api's OWN view of the dashboard port: the self-app boot reconcile points
    // the operator's domain at the dashboard through this (self-deploy.ts), and it
    // silently defaults to 3001 when unset. Ports are dynamic now, so leaving it
    // out publishes a domain routed to a port nothing is listening on.
    `OPENSHIP_DASHBOARD_PORT=${cfg.dashPort}`,
    // Alternate CA/EAB values are operator configuration (including one secret),
    // so a routine `openship up`/upgrade must not silently discard them.
    ...renderAcmeEnv(prev),
  ];
  if (cfg.bindAddr) lines.push(`OPENSHIP_BIND_ADDR=${cfg.bindAddr}`);
  // The origin allowlist. Losing either of these is the ORIGIN_REJECTED failure
  // described on keepConfig — they are written whenever they are known, never
  // conditionally on this run having been given a flag.
  if (cfg.publicUrl) lines.push(`OPENSHIP_PUBLIC_URL=${cfg.publicUrl}`);
  if (cfg.extraTrustedOrigins) {
    lines.push(`OPENSHIP_EXTRA_TRUSTED_ORIGINS=${cfg.extraTrustedOrigins}`);
  }
  if (cfg.trustProxy) lines.push("TRUST_PROXY=true");
  if (host) {
    // Activates createHostExecutor → SSH to the host; OPENSHIP_HOST_KEY_PATH is
    // the compose-side source for the /run/secrets/openship_host_key mount.
    lines.push(
      "OPENSHIP_HOST_SSH_HOST=host.docker.internal",
      `OPENSHIP_HOST_SSH_USER=${host.user}`,
      "OPENSHIP_HOST_SSH_PORT=22",
      "OPENSHIP_HOST_SSH_KEY=/run/secrets/openship_host_key",
      `OPENSHIP_HOST_KEY_PATH=${host.keyPath}`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * The monorepo checkout to BUILD the stack from, when this is a from-source
 * ("dev") install — `openship-dev`, whose marker records the checkout dir.
 *
 * A dev install tracks a branch, so its `__CLI_VERSION__` names a release tag
 * that isn't published: pulling `ghcr.io/oblien/openship-*:<that version>` fails
 * with `denied`. The checkout has the Dockerfiles, so build the three images we
 * own from it instead of pulling — same stack, same compose file, one override.
 * Returns null (→ pull path) when there's no checkout or no Dockerfiles in it.
 */
export function sourceBuildDir(): string | null {
  const marker = readSourceInstall();
  if (!marker?.dir) return null;
  const hasAll = BUILT_SERVICES.every((s) => existsSync(join(marker.dir, s.dockerfile)));
  return hasAll ? marker.dir : null;
}

/** Override file pointing the images we own at the checkout's Dockerfiles. */
function renderBuildOverride(repoDir: string): string {
  const services = BUILT_SERVICES.map(
    (s) => `  ${s.service}:
    build:
      context: ${repoDir}
      dockerfile: ${s.dockerfile}
`,
  ).join("");
  return `# Managed by \`openship up\` (from-source install) — builds instead of pulls.
services:
${services}`;
}

function materialize(opts: ComposeUpOpts): {
  buildDir: string | null;
  /** True when this run MINTED the db password (no prior .env to preserve it from). */
  /** The effective config that was written (flags over previous `.env`). */
  cfg: ReturnType<typeof resolveEnvConfig>;
  /**
   * The rendered `.env` DIFFERS from what was on disk. The api/dashboard/edge
   * services take it via `env_file:`, whose contents are baked into a container
   * at CREATE time — `up -d` alone reports "up-to-date" and keeps serving the old
   * environment. So this decides whether they get recreated.
   */
  envChanged: boolean;
} {
  mkdirSync(COMPOSE_DIR, { recursive: true, mode: 0o700 });
  const prev = readEnvFile();
  const cfg = resolveEnvConfig(prev, opts);
  // --no-host-control: never generate/authorize a host key in the first place.
  // Not just "don't use it" — there is nothing on disk to steal. Resolved through
  // cfg so a plain re-run keeps the install's original choice.
  const host = provisionHostSshChannel(cfg.hostControl);
  let before = "";
  try {
    before = readFileSync(ENV_FILE, "utf8");
  } catch {
    /* first install — no previous env, so everything is "changed" */
  }
  const rendered = renderEnv(opts, host, cfg);
  writeFileSync(COMPOSE_FILE, COMPOSE_YAML);
  writeFileSync(ENV_FILE, rendered, { mode: 0o600 });

  const buildDir = opts.build === false ? null : sourceBuildDir();
  if (buildDir) writeFileSync(BUILD_FILE, renderBuildOverride(buildDir));
  // `before === ""` is a first install: the containers don't exist yet and will be
  // created with this env, so there is nothing to force.
  return { buildDir, cfg, envChanged: before !== "" && rendered !== before };
}

/** `.env` keys whose VALUE must never be printed. Suffix-matched so a key added
 *  to renderEnv later is masked by default rather than leaked by omission. */
const SECRET_ENV_KEY = /(PASSWORD|SECRET|TOKEN|HMAC_KEY)$/;

/**
 * `materialize` WITHOUT the writes — everything a `--dry-run` needs to describe
 * the stack this run would install.
 *
 * The `.env` is rendered by `renderEnv` itself (masked), not re-listed here: a
 * hand-kept copy of the interesting keys is exactly how a preview starts lying —
 * a key added to the writer would silently go missing from the plan.
 */
export interface ComposePlan {
  composeFile: string;
  envFile: string;
  /** Marker `stop`/`update`/`status` route on, written once the stack is up. */
  installMethodFile: string;
  /** Build override, written only for a from-source install. */
  buildFile?: string;
  /** The compose file that would be written, verbatim. */
  yaml: string;
  /** The `.env` that would be written, with secret values masked. */
  settings: Array<{ key: string; value: string }>;
  /** Secret keys this run would GENERATE (absent from the current `.env`). */
  newSecrets: string[];
  /** True when a `.env` is already there — this would be a re-run, not a fresh install. */
  existing: boolean;
  /** Host directories the edge's bind mounts need (created on a real run). */
  mountDirs: string[];
  /** From-source checkout the images would be BUILT from (null = pull published). */
  buildDir: string | null;
  /** The container→host SSH channel this run would provision, if any. */
  hostChannel: { user: string; keyPath: string } | null;
}

export function composePlan(opts: ComposeUpOpts): ComposePlan {
  const prev = readEnvFile();
  const cfg = resolveEnvConfig(prev, opts);
  const buildDir = opts.build === false ? null : sourceBuildDir();
  const hostChannel = plannedHostChannel(cfg.hostControl);
  const settings: Array<{ key: string; value: string }> = [];
  const newSecrets: string[] = [];
  for (const line of renderEnv(opts, hostChannel, cfg).split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || line.startsWith("#")) continue;
    const key = line.slice(0, at);
    if (!SECRET_ENV_KEY.test(key)) {
      settings.push({ key, value: line.slice(at + 1) });
      continue;
    }
    // Generated once and preserved (see keepSecret) — say WHICH, never the value.
    const minted = !prev[key];
    if (minted) newSecrets.push(key);
    settings.push({ key, value: minted ? "<generated on this run>" : "<preserved>" });
  }
  return {
    composeFile: COMPOSE_FILE,
    envFile: ENV_FILE,
    installMethodFile: INSTALL_METHOD_FILE,
    ...(buildDir ? { buildFile: BUILD_FILE } : {}),
    yaml: COMPOSE_YAML,
    settings,
    newSecrets,
    existing: Object.keys(prev).length > 0,
    mountDirs: EDGE_CONTAINER_MOUNTS.map((m) => m.host),
    buildDir,
    hostChannel,
  };
}

/** Does this project's postgres data volume already exist (i.e. predate this run)? */
function dbVolumeExists(project: string): boolean {
  const r = spawnSync("docker", ["volume", "inspect", `${project}_postgres_data`], {
    stdio: "ignore",
  });
  return r.status === 0;
}

/** Run `docker compose <args>` in the compose dir, inheriting stdio. */
function compose(args: string[], opts?: { quiet?: boolean; withBuildOverride?: boolean }): number {
  const files = ["-f", COMPOSE_FILE];
  if (opts?.withBuildOverride) files.push("-f", BUILD_FILE);
  const r = spawnSync("docker", ["compose", ...files, ...args], {
    cwd: COMPOSE_DIR,
    stdio: opts?.quiet ? "ignore" : "inherit",
  });
  return r.status ?? 1;
}

/**
 * Fetch everything the stack needs WITHOUT starting it — so the operator's proxy
 * can keep serving while we do.
 *
 * The takeover order matters: pulling ~500MB of images takes minutes, and stopping
 * nginx first meant every hostname on the box was dark for all of it. Worse, a pull
 * that FAILED left them down for a problem that hadn't touched their proxy yet.
 * Fetch first, cut over second — the same "pull before anything stops" rule
 * `ensureContainerEdge` already follows for a bare→container conversion.
 *
 * Idempotent, and `composeUp` repeats these steps: after this they're cache hits, so
 * the actual downtime is the `up -d` swap (seconds), not the download.
 */
export function composePrefetch(opts: ComposeUpOpts): boolean {
  const { buildDir } = materialize(opts);
  if (buildDir) {
    // From-source: the BUILD is the slow part, so it belongs on this side of the
    // cutover too. Only the upstream images can be pulled for it.
    return (
      compose(["pull", "postgres", "redis"], { withBuildOverride: true }) === 0 &&
      compose(["build"], { withBuildOverride: true }) === 0
    );
  }
  return compose(["pull"]) === 0;
}

/**
 * Pre-create the edge's host bind-mount source directories so the Docker daemon
 * doesn't have to. Returns the dirs it COULDN'T create (empty = all good).
 *
 * A ROOTFUL daemon creates a missing mount source itself (as root), so a failure
 * here is harmless there — we stay quiet and let Docker do it (preserving the
 * rootful non-root-invoker case that works today). A ROOTLESS daemon runs as the
 * invoking user and CANNOT mkdir under root-owned /var/lib, /opt or /etc — it
 * dies with an opaque "error while creating mount source path … permission
 * denied" (#372). Callers pair a non-empty result with isRootlessDocker() to
 * surface a one-time fix instead of that.
 */
function ensureEdgeMountDirs(): string[] {
  const failed: string[] = [];
  for (const { host } of EDGE_CONTAINER_MOUNTS) {
    try {
      mkdirSync(host, { recursive: true });
    } catch (err) {
      // recursive mkdir is idempotent, so a throw means we truly can't (EACCES
      // under a root-owned parent — the rootless case), not "already there".
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") failed.push(host);
    }
  }
  return failed;
}

/** True when the Docker daemon runs rootless (a missing bind-mount source is
 *  created by the invoking user, not root). Probed only on the failure path. */
function isRootlessDocker(): boolean {
  const r = spawnSync("docker", ["info", "-f", "{{println .SecurityOptions}}"], {
    encoding: "utf8",
  });
  return r.status === 0 && /rootless/i.test(r.stdout ?? "");
}

/**
 * `openship up` (compose): write files, then either PULL the pinned images
 * (normal install) or BUILD api/dashboard/edge from the source checkout (dev
 * install). Postgres/redis are upstream images and are pulled either way.
 */
export async function composeUp(
  opts: ComposeUpOpts,
): Promise<{ ok: boolean; apiPort: string; dashPort: string }> {
  const { buildDir, cfg, envChanged } = materialize(opts);
  // The EFFECTIVE ports, not the flags: a re-run with no flags keeps the ports the
  // install was configured with, so the summary must report those.
  const apiPort = cfg.apiPort;
  const dashPort = cfg.dashPort;
  // `env_file:` contents are read when a container is CREATED, so a changed .env
  // reaches the api/dashboard/edge only if they're recreated. Without this, an
  // env fix "succeeds" and changes nothing.
  // The edge container mounts EDGE_SITES_HOST_DIR. A conf left there by an older or
  // failed attempt (a carried catch-all claiming `default_server`) crash-loops it with
  // `[emerg] a duplicate default server` — every time, forever, because the file is on
  // the host and outlives the container. Compose never carried anything, so it never
  // ran this; the file was created by some earlier path and then poisoned every
  // `openship up` after it. Sanitize what we're about to mount, every start.
  const up = (extra: { withBuildOverride?: boolean } = {}) =>
    compose(
      envChanged
        ? ["up", "-d", "--force-recreate", ...ENV_CONSUMING_SERVICES]
        : ["up", "-d"],
      extra,
    );

  // A previous stack under a different project name would still hold :80/:443
  // (host-networked edge) and 4000/3001, leaving the new edge in a bind() crash
  // loop while the old one serves stale vhosts. Clear it before bringing ours up.
  const env = readEnvFile();
  const project = env.COMPOSE_PROJECT_NAME || "openship";
  removeOrphanedStack(project);
  // The edge's pinned container_name collides with any openship-edge this project
  // doesn't own — a takeover's `docker run` edge, a from-source stack — which aborts
  // `up` with a name conflict that removeOrphanedStack can't clear. Take the name.
  reconcileEdgeContainerName(project);
  // Before anything mounts the new host paths: carry over an older install's
  // volume-held certs + vhosts, or the stack comes back up serving nothing.
  migrateLegacyEdgeVolumes(project);
  warnOrphanedVolumes(project);

  // #372: create the edge's bind-mount source dirs ourselves. A rootful daemon
  // would create any that are missing, but a rootless daemon runs as this user
  // and can't mkdir under root-owned /var/lib|/opt|/etc — it fails the whole
  // stack with an opaque "error while creating mount source path". If our own
  // create can't cover them AND the daemon is rootless, surface the one-time fix
  // rather than letting compose die cryptically.
  const unmakeableMounts = ensureEdgeMountDirs();
  if (unmakeableMounts.length && isRootlessDocker()) {
    const dirs = unmakeableMounts.join(" ");
    console.error(
      `\n  Rootless Docker can't create the edge's host directories under root-owned paths:\n` +
        `    ${unmakeableMounts.join("\n    ")}\n\n` +
        `  Create them once (owned by your user), then re-run \`openship up --compose\`:\n` +
        `    sudo mkdir -p ${dirs}\n` +
        `    sudo chown -R "$(id -un)" ${dirs}\n`,
    );
    return { ok: false, apiPort, dashPort };
  }

  // A surviving data volume can hold a password this `.env` doesn't know, and the
  // api then crash-loops on 28P01 behind a compose error that blames the wrong
  // thing. Realign it before anything depends on the db (see reconcileDbPassword).
  //
  // Runs whenever the volume exists — NOT only when this run minted new secrets.
  // Gating on "the .env had no password" only caught the first bad run: after it,
  // the .env HAS a password, so the guard never fired again and the install stayed
  // broken through every subsequent `openship up`. The mismatch is between the
  // VOLUME and the `.env`, which is not something the `.env`'s own history can tell
  // us. The ALTER is idempotent, so on a healthy install this is a no-op.
  if (dbVolumeExists(project)) {
    reconcileDbPassword(env.POSTGRES_USER || "openship", env.POSTGRES_PASSWORD ?? "");
  }

  await sanitizeEdgeVhosts(new LocalExecutor(), EDGE_SITES_HOST_DIR, (l) =>
    console.log(`  ${l.message}`),
  ).catch(() => {});

  if (buildDir) {
    // Only the upstream images can be pulled; ours don't exist in a registry for
    // this ref. `--pull=false` on build keeps it working offline after the first run.
    if (!opts.alreadyFetched) {
      if (compose(["pull", "postgres", "redis"], { withBuildOverride: true }) !== 0) {
        return { ok: false, apiPort, dashPort };
      }
      if (compose(["build"], { withBuildOverride: true }) !== 0) {
        return { ok: false, apiPort, dashPort };
      }
    }
    if (up({ withBuildOverride: true }) !== 0) {
      return { ok: false, apiPort, dashPort };
    }
    onEdgeContainerChanged();
    writeInstallMethod("compose");
    return { ok: true, apiPort, dashPort };
  }

  if (!opts.alreadyFetched && compose(["pull"]) !== 0) {
    return { ok: false, apiPort, dashPort };
  }
  if (up() !== 0) return { ok: false, apiPort, dashPort };
  onEdgeContainerChanged();
  writeInstallMethod("compose");
  return { ok: true, apiPort, dashPort };
}

/**
 * Compose just created (or replaced) `openship-edge` behind the detector's back —
 * `ensureContainerEdge` isn't in this path, so nothing else invalidates the
 * memoized "is our edge running" answer. This process cached `null` during
 * preflight, moments ago.
 */
function onEdgeContainerChanged(): void {
  invalidateEdgeContainer();
}

export function composeDown(): boolean {
  if (!existsSync(COMPOSE_FILE)) return false;
  return compose(["down"]) === 0;
}

/**
 * `openship uninstall` (compose): tear the stack down INCLUDING its volumes, and
 * optionally delete the images we own.
 *
 * `down -v` is the destructive part — those volumes hold the database. Only ever
 * called behind an explicit confirmation. `--remove-orphans` also collects
 * containers from an earlier project name so an uninstall doesn't leave a stale
 * edge holding :80/:443.
 *
 * Edge state on the HOST (`/etc/letsencrypt`, /var/lib/openship/edge, the static
 * doc-roots) is deliberately LEFT IN PLACE: issued certificates outlive an
 * uninstall/reinstall, and `/etc/letsencrypt` may be shared with a mail server or
 * anything else on the box. Removing it is the operator's call, not ours.
 *
 * Image removal is scoped to the three images we build/pull by exact reference —
 * never a prune, so a box sharing this daemon with the operator's own containers
 * (postgres, redis, their apps) is untouched.
 */
export function composeUninstall(opts: { removeImages?: boolean } = {}): {
  ok: boolean;
  removedImages: string[];
} {
  const removedImages: string[] = [];
  const ok = existsSync(COMPOSE_FILE)
    ? compose(["down", "-v", "--remove-orphans"]) === 0
    : false;

  if (opts.removeImages) {
    const env = readEnvFile();
    const registry = env.OPENSHIP_IMAGE_REGISTRY || DEFAULT_IMAGE_REGISTRY;
    const version = env.OPENSHIP_VERSION || "latest";
    for (const { service } of BUILT_SERVICES) {
      const ref = `${registry}/openship-${service}:${version}`;
      // Ours by exact tag. Upstream postgres/redis are left alone — they're
      // commonly shared with whatever else the operator runs on this box.
      if (spawnSync("docker", ["image", "rm", "-f", ref], { stdio: "ignore" }).status === 0) {
        removedImages.push(ref);
      }
    }
  }
  return { ok, removedImages };
}

/**
 * `openship update` (compose): the WHOLE update, so nothing has to be run after it.
 *
 * This is `composeUp` with the version repinned, deliberately — not a narrower
 * pull+up. The new CLI ships a new compose template (services, mounts, env keys)
 * and `composeUp` is the only thing that writes it, which is why operators ended
 * up running `openship up` afterwards to pick it up. That follow-up is what broke
 * installs: it regenerated `.env` from flags it wasn't given. Now the update path
 * regenerates both files itself, carrying every operator setting forward
 * (`resolveEnvConfig`), and force-recreates the env-consuming services when the
 * result differs. `openship up` afterwards is harmless but unnecessary.
 *
 * Covers both install shapes: a from-source install rebuilds from its checkout
 * (no published image for the branch it tracks), a normal one pulls.
 */
export async function composeUpdate(version?: string): Promise<boolean> {
  if (!existsSync(COMPOSE_FILE)) return false;
  return (await composeUp(version ? { version } : {})).ok;
}

export function composePs(): number {
  return compose(["ps"]);
}

/** True when at least one service in the stack is running — a clean boolean for
 *  the control panel (composePs prints a table + returns an exit code, which
 *  isn't a usable "is it up?" signal). */
export function composeRunning(): boolean {
  const r = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "ps", "--status", "running", "-q"],
    { cwd: COMPOSE_DIR, encoding: "utf8" },
  );
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** Bring the stack up in place (re-attach containers) — the control panel's
 *  "Start" for a compose install. Files already exist, so this is a plain
 *  `up -d`, NOT the full composeUp (materialize + pull/build). */
export function composeStart(): boolean {
  // Same name-conflict guard as composeUp: a foreign openship-edge would abort this
  // bare `up` too. Cheap when the edge is already ours (a no-op).
  reconcileEdgeContainerName(readEnvFile().COMPOSE_PROJECT_NAME || "openship");
  return compose(["up", "-d"], { quiet: true }) === 0;
}

/** Restart the running stack in place — the control panel's "Restart". */
export function composeRestart(): boolean {
  return compose(["restart"], { quiet: true }) === 0;
}

/**
 * The stack's INTERNAL_TOKEN, read from the generated compose `.env` — NOT the
 * bare-mode `~/.openship/internal-token`. The compose api container is booted
 * with this value (renderEnv → keepSecret), so the CLI must use it to reach
 * internal-token-gated endpoints (e.g. edge/import-sites after a migrate).
 */
export function composeInternalToken(): string | null {
  return readEnvFile().INTERNAL_TOKEN ?? null;
}

export const composePaths = { dir: COMPOSE_DIR, file: COMPOSE_FILE, env: ENV_FILE };
