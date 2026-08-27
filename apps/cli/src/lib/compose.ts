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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
  LocalExecutor,
  DEFAULT_DOCKER_SOCKET_PATH,
  EDGE_CONTAINER_MOUNTS,
  EDGE_HOST_STATE_DIR,
  invalidateEdgeContainer,
  resolveLocalDockerSocketPath,
  systemCatalog,
  resolveLocalEnvironmentSync,
} from "@repo/adapters";
import { sanitizeEdgeVhosts } from "@repo/adapters/proxy";
import {
  DEFAULT_IMAGE_REGISTRY,
  explainHostChannelCause,
  hostChannelAccount,
  HOST_CHANNEL_BLOCKED,
  HOST_CHANNEL_DEFAULT_ACCOUNT,
  HOST_CHANNEL_RECHECK,
  HOST_CHANNEL_UNAFFECTED,
  wrapText,
} from "@repo/core";

import {
  COMPOSE_DIR,
  COMPOSE_ENV_FILE as ENV_FILE,
  COMPOSE_FILE,
  readComposeEnvFile,
} from "./compose-env";
import { OS_DIR } from "./paths";
import {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  resolvePorts,
  type ResolvedPorts,
} from "./ports";
import { readSourceInstall } from "./source-install";
import { pasteable, thisHost } from "./this-host";

/** Host side of the edge's routing mounts — one source of truth with the api. */
const EDGE_SITES_HOST_DIR = `${EDGE_HOST_STATE_DIR}/sites-enabled`;
const EDGE_ACME_HOST_DIR = `${EDGE_HOST_STATE_DIR}/acme`;

/**
 * Physical bind source for the local Docker daemon.
 *
 * Docker Desktop and OrbStack need macOS's physical `/private/var` and
 * `/private/etc` paths; handing the daemon their `/var` and `/etc` symlink aliases
 * can mount empty VM directories instead (#692). Resolve as deeply as the local
 * filesystem allows so a first install still works before the leaf exists.
 * Linux deliberately keeps the stable logical paths used by existing installs.
 */
export function canonicalComposeHostPath(
  target: string,
  platform: NodeJS.Platform = process.platform,
  resolvePath: (path: string) => string = realpathSync,
): string {
  if (platform !== "darwin") return target;
  try {
    return resolvePath(target);
  } catch {
    let parent = target;
    while (parent !== dirname(parent)) {
      parent = dirname(parent);
      try {
        return join(resolvePath(parent), relative(parent, target));
      } catch {
        // Keep walking to the closest existing ancestor.
      }
    }
    throw new Error(`Could not resolve edge bind-mount source ${target} on this Mac.`);
  }
}

function composeEdgeMounts(): ReadonlyArray<{ host: string; container: string }> {
  return EDGE_CONTAINER_MOUNTS.map((mount) => ({
    ...mount,
    host: canonicalComposeHostPath(mount.host),
  }));
}

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
  return composeEdgeMounts().map((m) => `${indent}- ${m.host}:${m.container}:z`).join("\n");
}

/** Marker the API service's volume list carries until {@link renderComposeYaml} fills it. */
const DOCKER_CONFIG_MOUNT_MARKER = "__OPENSHIP_DOCKER_CONFIG_MOUNT__";

/**
 * The API's read-only Docker-config mount, or nothing when the host has none.
 *
 * `/root/.docker/config.json` because the API image declares no `USER` and so runs as
 * root — `resolveDockerAuth` looks under `homedir()`, and the two must agree or the
 * file is mounted somewhere nothing reads.
 *
 * LONG syntax, not `source:target:ro`: the host path comes from the environment and may
 * contain a colon or a space, either of which makes the short form parse as a different
 * mount (or not parse at all). `source` is JSON-quoted for the same reason.
 *
 * Only when the path is a REGULAR FILE. Docker happily bind-mounts a missing source by
 * creating a DIRECTORY at it, which would leave `/root/.docker/config.json` a directory
 * inside the container — every read then fails with EISDIR rather than "no credentials".
 */
function dockerConfigMountYaml(indent: string): string {
  const path = resolve(process.env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json");
  try {
    if (!statSync(path).isFile()) return "";
  } catch {
    return ""; // no config on this host — mount nothing
  }
  return [
    `${indent}- type: bind`,
    `${indent}  source: ${JSON.stringify(path)}`,
    `${indent}  target: /root/.docker/config.json`,
    `${indent}  read_only: true`,
  ].join("\n");
}

/**
 * The compose file to write.
 *
 * Everything static lives in `COMPOSE_YAML`; only what depends on the host at RUN time
 * is substituted here. Resolving the Docker config inside the module-level template
 * would freeze it at import, which both hides a config created since startup and makes
 * the generator untestable (a test setting DOCKER_CONFIG would never be observed).
 */
function renderComposeYaml(): string {
  const mount = dockerConfigMountYaml("      ");
  return COMPOSE_YAML.split(`${DOCKER_CONFIG_MOUNT_MARKER}\n`).join(mount ? `${mount}\n` : "");
}

declare const __CLI_VERSION__: string;

const INSTALL_METHOD_FILE = join(OS_DIR, "install-method");
/** From-source override: BUILDs api/dashboard/edge instead of pulling them. */
const BUILD_FILE = join(COMPOSE_DIR, "docker-compose.build.yml");
/** The `.env` this run replaced. See writeEnvFile — recovery for #488. */
const ENV_BACKUP_FILE = join(COMPOSE_DIR, ".env.bak");
const ENV_TMP_FILE = join(COMPOSE_DIR, ".env.tmp");

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
    // How THIS box starts a daemon, and whether it needs sudo to — both from the one
    // resolver. Hardcoded, this line offered `systemctl start docker` to an Alpine host
    // that has no systemctl and to a mac whose answer is "open Docker Desktop": the
    // advice for an unreachable daemon was unrunnable exactly where it was needed.
    const start = pasteable(thisHost().dockerStart());
    return {
      summary: "Docker is installed but its daemon isn't reachable",
      // Reinstalling changes nothing: a group change only applies to NEW logins,
      // and a stopped daemon needs starting, not installing.
      installable: false,
      hint: thisHost().profile.isRoot
        ? start
          ? `Start it with: ${start}`
          : "Start the Docker daemon — this host has no service manager Openship recognizes."
        : `Add your user to the docker group: sudo usermod -aG docker ${userInfo().username} — then log out and back in (or run: newgrp docker). If the daemon is stopped: ${start ?? "start it the way this host starts services"}`,
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
  /** The exact installer command for THIS distro, when there is one to run. */
  installCommand?: string;
  /** Best-effort daemon start that follows the install. */
  startCommand?: string;
  /** Why this box has no installer at all — an unsupported distro or arch. */
  unsupportedReason?: string;
  /**
   * Why the daemon can't be started here, though it can be installed.
   *
   * Distinct from a missing `startCommand`: a component with no service has neither, and
   * conflating the two is how Alpine installed Docker and then never started it.
   */
  startBlockedReason?: string;
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
  // The real profile of this box, not a fabricated `{os:"linux",serviceManager:"systemd"}`
  // cast: that literal is why `up` previewed (and ran) `curl get.docker.com | sh` on
  // Amazon Linux and Alpine, where that script refuses by `ID`, and why it previewed a
  // `systemctl` start on a box running OpenRC.
  const plan = systemCatalog.installs.docker(resolveLocalEnvironmentSync());
  if (!plan.supported) return { state, gap, wouldInstall: false, unsupportedReason: plan.reason };
  const start = plan.value.service;
  return {
    state,
    gap,
    wouldInstall: true,
    installCommand: plan.value.installCommand,
    ...(start?.supported ? { startCommand: start.value } : {}),
    ...(start && !start.supported ? { startBlockedReason: start.reason } : {}),
  };
}

/**
 * Ensure Docker + Compose are usable, auto-installing Docker if missing. Reuses
 * the SAME install command the deploy pipeline uses to provision target servers
 * (`systemCatalog.installs.docker`, which derives it from this host's package
 * manager), so there's one definition of "how we install Docker". Returns true
 * once `docker compose` works.
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
  const { state, gap, wouldInstall, installCommand, startCommand, unsupportedReason, startBlockedReason } =
    dockerInstallPreview();
  if (!gap) return true;
  if (process.platform !== "linux") return false;
  // An unreachable daemon is not an installation problem — say what to do and
  // stop, rather than running the Docker installer over a working install.
  if (!gap.installable) {
    notice(gap.summary + ".");
    if (gap.hint) notice(gap.hint);
    return false;
  }
  if (!wouldInstall || !installCommand) {
    // A REFUSED plan is not an absent one. `dockerInstallPreview` already names the
    // distro or arch it won't install on, and `wizard.ts` prints it on the preview
    // path — dropping it here meant the mutating path fell back to the bare service
    // in silence, which is the failure this whole layer exists to stop.
    if (unsupportedReason) notice(unsupportedReason);
    return false;
  }

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
  // No start command because the start step REFUSED — a box with no init we recognise.
  // The re-probe below reports only that Docker still isn't usable; without this the
  // one message that says WHY (and that the install itself worked) had no consumer at all.
  else if (startBlockedReason) notice(startBlockedReason);

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
  /** Address the api container dials for host ops, overriding
   *  `host.docker.internal` (see HOST_CHANNEL_DEFAULT_HOST). */
  hostSshHost?: string;
  /** Port the host's sshd listens on, if it isn't 22. */
  hostSshPort?: string;
  /** Pin the host account the channel logs in as, instead of letting provisioning settle
   *  on one (see chooseHostChannelUser). A pin never falls back. */
  hostSshUser?: string;
  apiPort?: string;
  dashboardPort?: string;
  publicUrl?: string;
  /** Extra browser origins to trust (comma-separated), e.g. a LAN IP + a domain. */
  extraTrustedOrigins?: string;
  trustProxy?: boolean;
  registry?: string;
  /** Image tag to pin (`--image-version`). Falls back to `OPENSHIP_VERSION` in the
   *  environment, then this CLI's version — the #486 escape hatch for a tag whose
   *  images the registry doesn't have yet. See resolveImageVersion. */
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
  /**
   * The change signal from a materialize this run ALREADY did — `composePrefetch`'s,
   * whose result the caller must pass through. See ComposePrefetchResult.envChanged for
   * why `composeUp` cannot work it out for itself once the prefetch has written `.env`.
   */
  envChanged?: boolean;
  /**
   * Proceed even though this run would regenerate secrets an existing data volume was
   * created with (see secretRotationRisk). The DB keeps its old password until
   * reconcileDbPassword realigns it, and every stored environment variable becomes
   * undecryptable — so this is a deliberate reset, never a retry.
   */
  resetSecrets?: boolean;
  /**
   * Install as Openship Mail: the dashboard's default shell is the mail control
   * plane rather than the full platform (`OPENSHIP_PRODUCT`). Absent on a re-run
   * keeps whatever the install chose — see resolveEnvConfig.
   */
  mail?: boolean;
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
      # The daemon socket, at the path the api's own default expects INSIDE the
      # container. The HOST side is a variable because it MOVES: a rootless daemon
      # keeps its socket under the invoking user's runtime dir, and Docker creates a
      # missing bind source as an empty DIRECTORY instead of failing — so the rootful
      # path there brings the stack up and then fails every container operation in
      # the transport, naming neither the path nor the cause (#482). \`openship up\`
      # writes OPENSHIP_DOCKER_SOCKET when the detected path isn't this default.
      - \${OPENSHIP_DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock
      # Registry credentials for private-image pulls. The API talks to the daemon over
      # the socket above via dockerode, which — unlike the docker CLI — reads no
      # config.json of its own, so a private pull went out anonymous on a logged-in
      # host (#581). Mounted READ-ONLY and only into this service; absent entirely when
      # the host has no config, so nothing is invented. Substituted at write time (the
      # path depends on DOCKER_CONFIG and on the file existing), hence the marker.
__OPENSHIP_DOCKER_CONFIG_MOUNT__
      # Routing state shared with the edge, as HOST BIND MOUNTS (generated from
      # EDGE_CONTAINER_MOUNTS): the vhost tree, /etc/letsencrypt, the ACME webroot
      # and the static doc-roots the API writes and the edge serves. Named volumes
      # hid all of it from every host-side reader (migrate's proxy scan, cert carry,
      # cert reuse, mail cert symlinks), each of which then silently saw "nothing".
${edgeVolumeYaml("      ")}
      # Host-op SSH key (createHostExecutor → host.docker.internal). /dev/null
      # when the host channel isn't provisioned → OPENSHIP_HOST_SSH_HOST stays
      # unset, and host operations REFUSE (they'd otherwise run against this
      # container's filesystem, #509) while ordinary deploys keep working over
      # the socket below.
      - \${OPENSHIP_HOST_KEY_PATH:-/dev/null}:/run/secrets/openship_host_key:ro
    # \`host-gateway\` is resolved by the daemon and is right on a stock rootful
    # install. It is NOT universally right: under rootless Docker it lands in
    # RootlessKit's namespace rather than the host's, so the host's sshd isn't
    # there (#482). OPENSHIP_HOST_GATEWAY re-points the alias (e.g. at the box's
    # LAN address) without patching this file, which \`openship up\` rewrites.
    extra_hosts: ["host.docker.internal:\${OPENSHIP_HOST_GATEWAY:-host-gateway}"]
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

/**
 * Secrets the CLI generates ONCE. None of them can be re-derived, and for each one a
 * fresh value is actively wrong on an install that already has data:
 *  · POSTGRES_PASSWORD is only ever applied by initdb, so a new value cannot match a
 *    volume that already exists — the api then fails 28P01 (see reconcileDbPassword).
 *  · BETTER_AUTH_SECRET is the AES key for every stored environment variable, so a new
 *    one makes every `env_var` row in the database permanently undecryptable.
 *  · INTERNAL_TOKEN is how this CLI authenticates to the running api.
 */
const GENERATED_SECRET_KEYS = ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "INTERNAL_TOKEN"] as const;

/**
 * The postgres data volume of an install that already exists on this box, if any.
 *
 * Probed across every project name we could own — the pinned one plus both historical
 * defaults (see composeProjectName) — because this lookup exists for the case where
 * `.env`, the thing that would tell us the name, is exactly what we can't read.
 */
function survivingDbVolume(prev: Record<string, string>): string | null {
  const candidates = new Set([prev.COMPOSE_PROJECT_NAME, "openship", "compose"]);
  for (const project of candidates) {
    if (project && dbVolumeExists(project)) return `${project}_postgres_data`;
  }
  return null;
}

/**
 * #488: whether this run would MINT a secret that an existing install already has a
 * different value for.
 *
 * `keepSecret` reuses whatever `.env` yields and generates the rest, which is right on a
 * first install and silently destructive on a re-run whose `.env` stopped yielding —
 * unreadable (root-owned 0600 and this run isn't root; `sudo` pointing HOME at a
 * different `~/.openship`), truncated by an interrupted write, or restored from a backup
 * without it. `up` then regenerated the secrets AND overwrote the file, so the only copy
 * of the real values was gone before anything looked wrong. What the operator saw, later,
 * was the api crash-looping on `password authentication failed for user "openship"` —
 * because the data volume still holds the ORIGINAL password.
 *
 * A surviving data volume is the evidence, since it outlives every way `.env` can go bad.
 * Callers stop on a non-null result: at that point nothing has been written, which is the
 * whole reason the old `.env` is still recoverable. `--reset-secrets` is the deliberate
 * way past, for an operator who really does want a reset.
 */
function secretRotationRisk(
  prev: Record<string, string>,
): { volume: string; keys: string[] } | null {
  const keys = GENERATED_SECRET_KEYS.filter((k) => !prev[k]);
  if (keys.length === 0) return null;
  const volume = survivingDbVolume(prev);
  return volume ? { volume, keys: [...keys] } : null;
}

/**
 * The same check against the `.env` on disk, for callers that must stop BEFORE anything
 * writes it. Every entry point that reaches `materialize` gates on this — `up` and the
 * wizard ahead of their prefetch (which materializes too), and composeUp itself for
 * `openship update`. Cheap enough to run more than once: one `docker volume inspect`.
 */
export function composeSecretRotationRisk(
  opts: ComposeUpOpts = {},
): { volume: string; keys: string[] } | null {
  if (opts.resetSecrets) return null;
  return secretRotationRisk(readEnvFile());
}

/**
 * What to tell the operator when `up` refuses to rotate secrets.
 *
 * Shared with the dry run so the preview and the real run cannot describe this state
 * differently — the whole complaint in #488 was a preview that said one thing and a run
 * that did another. Names the file, the volume, and the way out, because the operator
 * hitting this has an install that still works and one file to put back.
 *
 * The way out is one of THREE, and telling an operator the wrong one costs them the
 * secrets this gate exists to protect (see secretRecoveryAdvice): our install with a
 * backup, our install without one, and a stack we never created and are about to adopt.
 */
export function renderSecretRotationRefusal(
  rotation: { volume: string; keys: string[] },
  /** The dry run describes the same refusal in the future tense — it isn't refusing now. */
  opts: { dryRun?: boolean } = {},
): string {
  return (
    `\n  ${opts.dryRun ? "A real run would REFUSE here" : "Refusing to continue"}:` +
    ` this would regenerate secrets your existing install already has.\n\n` +
    `    missing from ${ENV_FILE}:  ${rotation.keys.join(", ")}\n` +
    `    but this install's data is still here:  ${rotation.volume}\n\n` +
    `  A new POSTGRES_PASSWORD cannot match that volume — Postgres only applies the password\n` +
    `  when it first creates the data directory — and a new BETTER_AUTH_SECRET cannot decrypt\n` +
    `  the environment variables already stored in the database. Nothing has been written yet.\n\n` +
    secretRecoveryAdvice(rotation)
  );
}

/**
 * Where the original secrets actually ARE, for the three installs that reach the refusal.
 *
 * The first version of this branched only on whether `.env.bak` existed, so on the shape
 * that reaches it most often it said "restore `.env` from a backup, or copy the keys above
 * out of one" — about a file that had never existed. That install is one we ADOPTED:
 * `docker/docker-compose.yml` pins `name: openship`, the same project name this CLI pins
 * (composeProjectName), so `openship up` on a box already running the raw compose stack
 * takes over its containers and its `openship_postgres_data`. The operator got there by
 * following #509's own advice to re-run `openship up`, and there is nothing of ours on
 * disk to put back — the values are in the container we're about to replace.
 *
 * `--reset-secrets` is named in every branch and framed in every branch as what it is: it
 * makes every stored environment variable permanently unreadable, so it is the last
 * resort, never the quick way past a refusal.
 */
function secretRecoveryAdvice(rotation: { volume: string; keys: string[] }): string {
  const adopted = adoptedStack(projectOfDbVolume(rotation.volume));
  if (adopted) {
    return (
      `  This stack was not created by \`openship up\`: it is already running under the compose\n` +
      `  project name we pin, so this run would ADOPT it.\n\n` +
      `    project:      ${adopted.project}\n` +
      `    started from: ${adopted.configFiles || "an unlabelled `docker run`"}\n` +
      `    not from:     ${COMPOSE_FILE}\n\n` +
      `  So there is no \`.env\` of ours to restore and no backup of one — the real values are in\n` +
      `  the api container's own environment. Copy them out of it, then re-run:\n\n` +
      `    echo 'COMPOSE_PROJECT_NAME=${adopted.project}' >> ${ENV_FILE}\n` +
      `    docker inspect ${adopted.apiContainer} --format '{{range .Config.Env}}{{println .}}{{end}}' \\\n` +
      `      | grep -E '^(${rotation.keys.join("|")})=' >> ${ENV_FILE}\n\n` +
      `  COMPOSE_PROJECT_NAME matters as much as the secrets do: it is the volume prefix, so\n` +
      `  without it this stack comes up on empty volumes beside the data above.\n\n` +
      `  Only if that container is gone and the values exist nowhere else — this DESTROYS them,\n` +
      `  leaving every environment variable stored in the database permanently unreadable:\n` +
      `    openship up --reset-secrets\n`
    );
  }
  return (
    `  Put the original values back and re-run:\n` +
    (existsSync(ENV_BACKUP_FILE)
      ? `    cp ${ENV_BACKUP_FILE} ${ENV_FILE}     # the .env a previous \`openship up\` replaced\n`
      : `    restore ${ENV_FILE} from a backup, or copy the keys above out of one\n`) +
    `  If the file is there but this user can't read it, re-run as the user that owns it\n` +
    `  (or as root) rather than letting the secrets be regenerated.\n\n` +
    `  To reset instead — the database password gets realigned, but every stored environment\n` +
    `  variable becomes permanently unreadable:\n` +
    `    openship up --reset-secrets\n`
  );
}

/** The compose project that owns `<project>_postgres_data` — the stack whose data the
 *  refusal is protecting, which is the one to look for evidence about. */
function projectOfDbVolume(volume: string): string {
  return volume.replace(/_postgres_data$/, "");
}

/**
 * Parse the existing .env so re-running `up` preserves generated secrets.
 *
 * The read itself lives in lib/compose-env (shared with the internal-token resolver);
 * what stays here is the install-time REPORTING of a file that exists and wouldn't
 * open — a root-owned 0600 `.env` this user can't see is an install whose secrets are
 * merely out of reach, and treating that as a first install is what #488 is.
 * secretRotationRisk is what actually stops the run.
 */
function readEnvFile(): Record<string, string> {
  const { env, unreadable } = readComposeEnvFile();
  if (unreadable) {
    console.log(
      `  ! Could not read ${ENV_FILE}: ${unreadable}\n` +
        `    Its contents are being treated as absent. If this install already exists,` +
        ` fix the permissions and re-run rather than letting secrets be regenerated.`,
    );
  }
  return env;
}

/**
 * Where the api container reaches the host by default: the docker-provided alias,
 * mapped to `host-gateway` in the compose template. Overridable per-install (see
 * `resolveEnvConfig`) because it is a good default, not a universal fact.
 */
const HOST_CHANNEL_DEFAULT_HOST = "host.docker.internal";
const HOST_CHANNEL_DEFAULT_PORT = 22;

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
 * here. Two are then named back, and BOTH re-grants rest on the same observation:
 * this key already authorizes arbitrary command execution on the host, so a
 * capability that only changes how that execution is framed adds no privilege.
 *
 * `pty`: `restrict` implies `no-pty`, and the host terminal
 * (`SshExecutor.openShell` → `client.shell({ term, cols, rows })`) needs one.
 *
 * `port-forwarding`: the deploy-time readiness probe reaches a published candidate
 * at `127.0.0.1:<hostPort>` — an address that only means the right thing from the
 * HOST — by opening an ssh2 `direct-tcpip` channel (`SshExecutor.forwardPort` →
 * `client.forwardOut`). `restrict` denies exactly that, so the probe's channel open
 * was refused "administratively prohibited", the refusal was indistinguishable from
 * a closed port, and every readiness-gated deploy on a Compose install failed with
 * "the app never answered" while `curl` on the host returned 200 — GH-583.
 *
 * Not the security regression it looks like: a leaked key that can run `curl` (or
 * `nc`, or write and execute a file) on the host can already reach anything bound
 * on it, with or without a tunnel. `permitopen=` is deliberately NOT used to narrow
 * this — sshd matches it literally, with no CIDR support, and the probe's other
 * target is a Docker bridge IP from a range that is only known at deploy time.
 */
function hostKeyAuthLine(pub: string): string {
  return `from="${HOST_KEY_FROM}",restrict,pty,port-forwarding ${pub}`;
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
  return [...keptForeignKeys(existing), hostKeyAuthLine(pub)].join("\n") + "\n";
}

/** Every line that isn't ours, which is every line we must never touch. */
function keptForeignKeys(existing: string): string[] {
  return existing.split("\n").filter((line) => line.trim() && !line.includes(HOST_KEY_COMMENT));
}

/**
 * PURE. The same file with our line GONE and nothing put back — the `--no-host-control`
 * half of {@link rewriteHostAuthorizedKeys}.
 *
 * Exported for tests for the same reason as its sibling: it edits the file that decides
 * who can log into the box, and the failure mode (dropping a line the operator added)
 * doesn't announce itself.
 */
export function stripHostAuthorizedKeys(existing: string): string {
  const kept = keptForeignKeys(existing);
  return kept.length ? kept.join("\n") + "\n" : "";
}

/**
 * What a provisioned host channel looks like: the account it logs in as, where its
 * private key lives, which `authorized_keys` file gets the public key, and — for a
 * non-root invoker — whether that write goes through sudo.
 */
export type HostChannelTarget = {
  user: string;
  keyPath: string;
  authKeysPath: string;
  /** No way to reach root (non-root invoker, no passwordless sudo): the channel logs
   *  in as the invoker and CANNOT do root host ops — the caller must warn. */
  rootUnavailable: boolean;
  /**
   * How this channel reaches root once connected — what the api will do at run time, not
   * what provisioning did.
   *
   * `login` is a root session; `sudo` is a non-root session that elevates per operation
   * through `privilegedExecutor`. Surfaced so the dry-run preview can say which, instead
   * of repeating a root warning that no longer applies to the sudo case.
   */
  elevation: "login" | "sudo" | "none";
  /** Accounts provisioning would fall through to if this one's dial is refused. Only the
   *  dry-run preview sets this — a real run has already settled (see previewHostChannel). */
  fallbacks?: readonly string[];
};

/**
 * One account provisioning may settle on, in the order it will try them.
 *
 * A LIST rather than a single choice because `authorized_keys` is a file we write and not
 * a verdict sshd gives: the only thing that can establish whether an account works is
 * dialing it (verifyChannelAuth). #527 is what a single choice costs — a box with
 * `PermitRootLogin no` got the root arm, the key landed in a file sshd would never
 * consult for a login it refuses outright, and there was no second thing to try.
 */
export type HostChannelCandidate = {
  user: string;
  authKeysPath: string;
  /** PREDICTED elevation. The dial measures the truth and may downgrade it to `none`
   *  (see provisionHostSshChannel) — this is what we expect before asking. */
  elevation: "login" | "sudo" | "none";
  /**
   * Why this account is in the list. Load-bearing for two reasons: `pin` must never fall
   * through to another account (the operator named one), and the settle line names the
   * source so an auto-migration says what it did rather than silently changing which
   * credential exists on the box.
   */
  source: "pin" | "carried" | "root" | "sudo-user" | "invoker";
};

const ROOT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";

/**
 * PURE. Decide which account the container→host SSH channel logs in as, given the
 * invoking user and whether passwordless sudo is available.
 *
 * Host operations need root. They do NOT need a root LOGIN — that is the distinction this
 * function used to miss. `privilegedExecutor` already elevates a non-root sudo session per
 * operation (packages/adapters/src/system/privilege.ts), and the deploy path, the
 * installer and the on-box state store all reach root that way. So a sudo-capable operator
 * gets a channel that logs in AS THEM and elevates, rather than one that mints a standing
 * root SSH credential to buy access the platform already had.
 *
 * Minting it was the old middle arm, and it bought a materially bigger blast radius than
 * the docker socket this channel is justified against — the argument this file already
 * makes about the key's own scope. It also broke boxes it was supposed to help: a host with
 * `PermitRootLogin no` (a normal hardening choice, and #527's likely shape) got a root
 * channel sshd refuses, after the working alternative had been revoked.
 *
 *   - invoked AS root              → already root, write /root directly. Nothing to mint.
 *   - non-root + passwordless sudo → log in as the invoker and ELEVATE per operation.
 *   - non-root, no sudo            → the invoker, with no route to root at all; flagged so
 *                                    the caller warns loudly.
 *
 * What still needs a root login, and is therefore degraded on the sudo arm: the host
 * TERMINAL is a PTY channel that no elevation decorator wraps, so it opens an unprivileged
 * shell (the operator types `sudo -i`). SFTP cannot be elevated either, which is why
 * `scratchDir()` exists beside `stateDir()` in adapters.
 *
 * An operator who WANTS a root channel runs the installer as root — `sudo openship up`
 * makes the invoker uid 0, and root is therefore the FIRST candidate on that arm. That is
 * deliberately the only way to end up with a standing root credential: this function will
 * not mint one for an account it is not logging in as.
 *
 * Why the root arm returns a SECOND candidate (#527): a root login is a request sshd is
 * free to refuse, and `PermitRootLogin no` is an ordinary hardening choice. Before this,
 * the root arm was terminal — the key went into `/root/.ssh/authorized_keys`, sshd refused
 * every dial, and `.env` was written pointing at the refusal. When the run was `sudo`'d we
 * already know an account that CAN log in (the operator just used it), so `$SUDO_USER`
 * follows root as the fallback. It is only ever reached when root's dial actually fails,
 * so a working root install is never migrated out from under an operator who asked for it.
 *
 * Nothing has to move for that migration: the on-box state under /root/.openship is
 * reached through `privilegedExecutor`, which elevates.
 *
 * `carried` is promoted to the front when it names a candidate we already have, purely to
 * avoid re-authorizing (and then revoking) a file the previous run already settled away
 * from. It cannot introduce an account of its own — an account we would have to elevate
 * to write to is one we are not logging in as, which is the thing de-rooting removed.
 *
 * PURE: every account it can name is resolved by the caller (`plannedHostChannel`), so the
 * decision is testable without a passwd database or a live sshd.
 *
 * Exported for tests: this decision is the whole fix, so it's verified directly.
 */
export function chooseHostChannelUser(input: {
  invokerUid: number;
  invokerName: string;
  invokerHome: string;
  hasPasswordlessSudo: boolean;
  /** `--host-ssh-user` (or the pin it left in `.env`): one candidate, no fallback. */
  pinned?: { user: string; home: string } | null;
  /** `$SUDO_USER` resolved through the passwd database — NOT `$HOME`, which sudo has
   *  already rewritten to root's. Null when this isn't a sudo'd run. */
  sudoUser?: { user: string; home: string } | null;
  /** The account the previous run settled on, from `.env`. */
  carried?: string | null;
}): HostChannelCandidate[] {
  const keysFor = (home: string) => join(home, ".ssh", "authorized_keys");
  // An operator who names an account has overridden the decision, not seeded it: falling
  // back past a pin would hand them a channel on an account they deliberately excluded.
  if (input.pinned) {
    return [
      {
        user: input.pinned.user,
        authKeysPath:
          input.pinned.user === "root" ? ROOT_AUTHORIZED_KEYS : keysFor(input.pinned.home),
        // Unknowable for an arbitrary account; the dial measures it (see provisionHostSshChannel).
        elevation: input.pinned.user === "root" ? "login" : "sudo",
        source: "pin",
      },
    ];
  }

  const candidates: HostChannelCandidate[] = [];
  if (input.invokerUid === 0) {
    candidates.push({
      user: "root",
      authKeysPath: ROOT_AUTHORIZED_KEYS,
      elevation: "login",
      source: "root",
    });
    // Only when sudo named a real, non-root account. A genuine root login (`ssh root@box`)
    // sets no SUDO_USER, and there is then no second account we could authorize without
    // becoming the thing de-rooting removed — so that box legitimately has one candidate.
    if (input.sudoUser && input.sudoUser.user !== "root") {
      candidates.push({
        user: input.sudoUser.user,
        authKeysPath: keysFor(input.sudoUser.home),
        elevation: "sudo",
        source: "sudo-user",
      });
    }
  } else {
    candidates.push({
      user: input.invokerName,
      authKeysPath: keysFor(input.invokerHome),
      // Reaches root through sudo at run time, so this is NOT `rootUnavailable` — the
      // caller must not warn that mail and edge will fail, because they won't.
      elevation: input.hasPasswordlessSudo ? "sudo" : "none",
      source: "invoker",
    });
  }

  const carried = input.carried?.trim();
  if (!carried) return candidates;
  const already = candidates.findIndex((c) => c.user === carried);
  if (already <= 0) return candidates;
  const [promoted] = candidates.splice(already, 1);
  return [{ ...promoted, source: "carried" }, ...candidates];
}

/**
 * Read-only probe: does `sudo` run without prompting for a password?
 *
 * `-n` never prompts — it exits non-zero instead — so this changes nothing on the host.
 * `-k` is what makes the answer mean anything: without it, sudo accepts a cached timestamp
 * ticket from the operator's terminal, so a box with NO passwordless rule at all answered
 * yes for the lifetime of that ticket. The api container then elevates from a fresh,
 * tty-less ssh session that has no ticket and never will, so the probe was answering a
 * different question from the one the caller asks. `-k` invalidates the ticket for this
 * one invocation only (it does not clear the operator's cached credentials).
 *
 * A `true` here is still only a prediction — `provisionHostSshChannel` measures elevation
 * over the channel it actually dials, which is the session shape the api will use.
 */
function hasPasswordlessSudo(): boolean {
  try {
    return spawnSync("sudo", ["-n", "-k", "true"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * `$SUDO_USER`, resolved through the passwd database into an account + home.
 *
 * `$HOME` is deliberately not consulted: sudo has already rewritten it to root's, so
 * trusting it would authorize the key into `/root/.ssh/authorized_keys` while telling the
 * container to log in as someone else — the exact drift `plannedHostChannel` uses
 * `userInfo()` to avoid on the other arm.
 */
function sudoInvoker(): { user: string; home: string } | null {
  const user = process.env.SUDO_USER?.trim();
  if (!user || user === "root") return null;
  const home = passwdHome(user);
  return home ? { user, home } : null;
}

/** What the account decision needs off the resolved env config (see resolveEnvConfig). */
type HostChannelPlanCfg = {
  hostControl: boolean;
  /** `--host-ssh-user`, or the pin a previous run of it left in `.env`. */
  hostSshUser?: string;
  /** The account the previous run SETTLED on (`.env` OPENSHIP_HOST_SSH_USER) — continuity,
   *  not a pin: it is tried first and falls through like any other candidate. */
  hostSshUserCarried?: string;
};

/**
 * The container→host SSH channel accounts a run WOULD try, in order — resolved identically
 * for the dry-run preview and the real provisioner, so a preview can't describe a channel
 * the install wouldn't provision (or miss one it would). Null when there won't be one
 * (`--no-host-control`, or a non-Linux box: host.docker.internal SSH is the Linux path).
 */
function plannedHostChannel(
  cfg: HostChannelPlanCfg,
): { candidates: HostChannelCandidate[]; keyPath: string } | null {
  if (!cfg.hostControl || process.platform !== "linux") return null;
  // `userInfo()` rather than $USER: os.homedir() and $USER can disagree under sudo
  // (HOME=/root with USER preserved, or vice versa), which would write the key into
  // one account's authorized_keys while telling the container to log in as another.
  // userInfo() is the same passwd entry homedir() resolves from, so the two can't drift.
  let invoker: { uid: number; username: string; home: string };
  try {
    const info = userInfo();
    invoker = { uid: info.uid, username: info.username, home: info.homedir };
  } catch {
    invoker = { uid: -1, username: process.env.USER || process.env.LOGNAME || "root", home: homedir() };
  }
  const pin = cfg.hostSshUser?.trim();
  const candidates = chooseHostChannelUser({
    invokerUid: invoker.uid,
    invokerName: invoker.username,
    invokerHome: invoker.home,
    // Only probe sudo when it could change the outcome — a root invoker never needs it.
    hasPasswordlessSudo: invoker.uid !== 0 && hasPasswordlessSudo(),
    // A pinned account is dialed, never written to on our guess about its home: root's
    // file is fixed, and any other account's comes from the passwd database.
    pinned: pin ? { user: pin, home: passwdHome(pin) ?? join("/home", pin) } : null,
    sudoUser: invoker.uid === 0 ? sudoInvoker() : null,
    carried: cfg.hostSshUserCarried ?? null,
  });
  return { candidates, keyPath: join(COMPOSE_DIR, "host-ssh", "id_ed25519") };
}

/** An account's home from the passwd database, or null when it has none/doesn't exist. */
function passwdHome(user: string): string | null {
  try {
    const r = spawnSync("getent", ["passwd", user], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").split("\n")[0]?.split(":")[5]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The channel the dry-run preview describes: the first account provisioning will TRY,
 * plus the accounts it would fall through to.
 *
 * A preview must not dial — a dial means authorizing a key, which is the write the preview
 * exists to describe rather than perform — so it can only ever name the first candidate.
 * `fallbacks` is how it stays honest about that: the run may settle elsewhere, and an
 * operator reading a plan that promised one account and got another would rightly read it
 * as the plan being wrong.
 */
function previewHostChannel(cfg: HostChannelPlanCfg): HostChannelTarget | null {
  const plan = plannedHostChannel(cfg);
  if (!plan) return null;
  const [first, ...rest] = plan.candidates;
  if (!first) return null;
  return {
    user: first.user,
    keyPath: plan.keyPath,
    authKeysPath: first.authKeysPath,
    rootUnavailable: first.elevation === "none",
    elevation: first.elevation,
    fallbacks: rest.map((c) => c.user),
  };
}

/**
 * Read-modify-write our restricted key line into `authKeysPath` with Node fs — the file
 * is writable by this process (either /root because we ARE root, or the invoker's own).
 */
function authorizeKeyAt(authKeysPath: string, pub: string): void {
  mkdirSync(dirname(authKeysPath), { recursive: true, mode: 0o700 });
  const existing = existsSync(authKeysPath) ? readFileSync(authKeysPath, "utf8") : "";
  const next = rewriteHostAuthorizedKeys(existing, pub);
  if (next !== existing) writeFileSync(authKeysPath, next, { mode: 0o600 });
  // mode: on writeFileSync only applies at CREATE, so a file that already existed keeps
  // its old permissions — set them explicitly.
  chmodSync(authKeysPath, 0o600);
}

/**
 * Openship no longer AUTHORIZES a root key on a non-root box — `chooseHostChannelUser`
 * logs in as the invoker and elevates instead, so there is nothing to mint. The revoke
 * below is deliberately kept: an install provisioned by an older CLI has a root line we
 * are no longer using, and leaving a standing root credential behind would be worse than
 * having created it.
 */

/**
 * Best-effort: strip our line from an `authorized_keys` this process can write.
 *
 * True means the file is clean afterwards — including "there was nothing of ours in
 * it", so a caller can't tell a no-op from a success and doesn't need to.
 */
function revokeKeyAt(authKeysPath: string): boolean {
  try {
    if (!existsSync(authKeysPath)) return true;
    const existing = readFileSync(authKeysPath, "utf8");
    if (!existing.includes(HOST_KEY_COMMENT)) return true;
    writeFileSync(authKeysPath, stripHostAuthorizedKeys(existing), { mode: 0o600 });
    chmodSync(authKeysPath, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** The same, on /root/.ssh/authorized_keys through `sudo -n`. Sweeps a root line left by
 *  an older CLI (or by a box that used to be provisioned as root) once this install has
 *  moved to an invoker channel. */
function revokeRootKeyViaSudo(): boolean {
  const read = spawnSync(
    "sudo",
    ["-n", "sh", "-c", `cat ${ROOT_AUTHORIZED_KEYS} 2>/dev/null || true`],
    { encoding: "utf8" },
  );
  if (read.status !== 0) return false;
  const existing = read.stdout ?? "";
  if (!existing.includes(HOST_KEY_COMMENT)) return true;
  // `tee` (not a shell `>`) so the redirect happens under root, not this shell.
  const write = spawnSync("sudo", ["-n", "tee", ROOT_AUTHORIZED_KEYS], {
    input: stripHostAuthorizedKeys(existing),
    stdio: ["pipe", "ignore", "ignore"],
  });
  return write.status === 0;
}

/**
 * `--no-host-control` on a box that already HAD a channel: take the credential back.
 *
 * Refusing to use a key is not the same as not having one. The flag used to leave both
 * halves in place — the private key under `~/.openship/compose/host-ssh` and the line in
 * `authorized_keys` — so "turns the channel off" was true of this install's behaviour and
 * false of the box's attack surface, which is the half an operator sets the flag for.
 *
 * The private key goes first and unconditionally: it is our own file, and without it the
 * authorized line grants nothing. Then the line, wherever it was written (root's file, or
 * the invoker's on a pre-#489 install) — and if that needs a root we don't have, the exact
 * command to finish it, rather than a silent partial revoke.
 *
 * Quiet when there was never a channel here: `--no-host-control` on a fresh install, and
 * every re-run after the first retirement, print nothing.
 */
function retireHostSshChannel(prev: Record<string, string>): void {
  const keyDir = join(COMPOSE_DIR, "host-ssh");
  if (!existsSync(keyDir) && !prev.OPENSHIP_HOST_SSH_HOST) return;

  const invokerKeys = join(homedir(), ".ssh", "authorized_keys");
  // Which file holds the line is what the channel logged in AS — root unless provisioning
  // settled on another account. A pre-#489 install wrote the invoker's file either way, so
  // that one is always swept too.
  const account = hostChannelAccount(prev);
  const asRoot = account === HOST_CHANNEL_DEFAULT_ACCOUNT;
  // Resolved from the ACCOUNT NAME, not from `homedir()`. Since provisioning can settle on
  // `$SUDO_USER`, the settled account and the invoker are no longer the same thing on a
  // sudo'd run — and `homedir()` there is root's, so inferring the path from it would
  // "revoke" a file that never held the line and silently leave the real grant live.
  const accountKeys = asRoot
    ? ROOT_AUTHORIZED_KEYS
    : (() => {
        const home = passwdHome(account);
        return home ? join(home, ".ssh", "authorized_keys") : invokerKeys;
      })();
  const weAreRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const revoked = asRoot
    ? weAreRoot
      ? revokeKeyAt(ROOT_AUTHORIZED_KEYS)
      : hasPasswordlessSudo() && revokeRootKeyViaSudo()
    : revokeKeyAt(accountKeys);
  // The invoker's own file on top, whenever it isn't the one already handled: a pre-#489
  // install put the line there, and so did a run whose settled account has since changed.
  const alsoInvoker = accountKeys === invokerKeys ? true : revokeKeyAt(invokerKeys);

  try {
    rmSync(keyDir, { recursive: true, force: true });
  } catch {
    /* the key is unusable the moment the channel is off; a leftover file is not a grant */
  }

  const stuck = accountKeys;
  // Names the `.env` half too: dropping OPENSHIP_HOST_SSH_* is the ONE case where those
  // keys legitimately disappear (a provisioning failure now carries them forward instead
  // — see carriedHostChannel), so the withdrawal has to be the thing that says so.
  console.log(
    revoked && alsoInvoker
      ? "  Host control off: dropped OPENSHIP_HOST_SSH_* from .env, deleted the host key and\n" +
          "  revoked its authorized_keys line."
      : `  Host control off: dropped OPENSHIP_HOST_SSH_* from .env and deleted the host key (it\n` +
          `  can no longer be used). Removing its line needs root — run:\n` +
          `  sudo sed -i '/${HOST_KEY_COMMENT}/d' ${stuck}`,
  );
}

/**
 * Why a run that WANTED a host channel hasn't got a working one.
 *
 * Only ever set when `plannedHostChannel` returned a target — i.e. host control is on
 * and this platform has a channel to provision. The two quiet cases (`--no-host-control`,
 * a non-Linux box) are not failures and carry no code, which is what keeps the call
 * site's warning off a box that correctly has no channel.
 */
type HostChannelIssueCode =
  /** `ssh-keygen` couldn't run or failed — there is no keypair to authorize. */
  | "keygen"
  /** The keypair exists but its public half read back empty. */
  | "empty-key"
  /** Reading or authorizing it threw: a `mkdir`/`authorized_keys` this user can't touch. */
  | "error"
  /** Provisioned fine, but nothing on this host is listening for SSH (see probeHostSshd). */
  | "no-sshd"
  /**
   * sshd is listening and REFUSED the key we just authorized (see verifyChannelAuth).
   *
   * The state #527 had no name for. `authorized_keys` is a file we write, not a verdict
   * sshd gives: it can be the wrong account's file, or the right one on a host whose
   * sshd permits that account no login at all. Both passed every check this install ran,
   * so the operator was told host control was on and found out weeks later, through an
   * unrelated operation, in wording that blamed their own credentials.
   */
  | "auth-refused"
  /**
   * sshd is listening on this host, but nothing accepted a connection at the address the
   * verification dial used — a `ListenAddress` that excludes loopback, or a local firewall.
   *
   * Its own code because the remedy is a different file from `auth-refused`'s: every
   * non-zero `ssh` exit used to be reported as a refused KEY, which sent operators to
   * `authorized_keys` on a host that had never read it.
   */
  | "unreachable"
  /**
   * The key was ACCEPTED and the session was then closed without running anything — sshd's
   * `forced-commands-only`, whose whole point is that our line carries no `command=`.
   *
   * Distinct from `auth-refused` because "the host refused the key" is factually wrong
   * here, and because it never prints `Permission denied`, so the two cannot be told apart
   * by matching ssh's message.
   */
  | "forced-command";

export interface HostChannelIssue {
  code: HostChannelIssueCode;
  /** The errno/message/port behind it, verbatim, for the operator. */
  detail?: string;
  /** The host account the channel logs in as. Only `auth-refused` needs it, and needs it
   *  badly: "the key was refused" is unactionable until you know WHICH account to go and
   *  authorize it for (root via sudo, or the invoking user — see chooseHostChannelUser). */
  account?: string;
  /** Every account this run dialed, in order, when more than one was tried. An operator
   *  told only about the last one would reasonably ask why we didn't try the obvious other
   *  account — and on a sudo'd run we did. */
  tried?: readonly string[];
  /** What `sshd -T` says about root logins, when it could be read. Advisory ONLY: it
   *  reports the GLOBAL config, so a `Match Address` block scoped to the docker bridge can
   *  make it disagree with the dial — which is why it explains a refusal and never causes
   *  one. See permitRootLoginSetting. */
  permitRootLogin?: string;
}

interface HostChannelProvision {
  /** The channel to write into `.env`, or null when this run produced none. */
  channel: { user: string; keyPath: string } | null;
  /** Set only when a channel was wanted and isn't (or can't yet) work. */
  issue?: HostChannelIssue;
}

/**
 * Provision the container→host SSH channel so the api container can run HOST-OS
 * ops (free a foreign proxy off :80/:443, host config) via createHostExecutor —
 * exactly what a bare install does locally. Idempotent: generates an ed25519 key under
 * the compose dir, authorizes it for the host account the ops run as (root when
 * reachable — see chooseHostChannelUser), and reports (user, keyPath) for the .env +
 * volume mount.
 *
 * Failing is NOT a graceful degrade, and this header used to say it was —
 * "createHostExecutor cleanly falls back to LocalExecutor" is the sentence #509 came out
 * of. LocalExecutor IS the host on a BARE install; here the api runs in a container,
 * where it is the CONTAINER's filesystem, so createHostExecutor throws rather than
 * operate on the wrong machine and every host operation on this box fails from the
 * moment the install reports success.
 *
 * So it stays best-effort — a keygen failure must not abort an otherwise-good install —
 * but it now returns WHY rather than a bare null. That reason exists nowhere else: every
 * later surface (the install preflight, the API banner, `openship doctor`, the deploy
 * log) sees only an unset OPENSHIP_HOST_SSH_HOST, which is why a failed keygen used to
 * look exactly like an operator who had opted out.
 *
 * Not a new privilege: the api container already holds host-root-equivalent access
 * through the mounted docker socket — this key just gives it a shell for the host ops the
 * socket can't do. sshd is the one prerequisite provisioning cannot create for itself; it
 * is reported, never installed.
 */
function provisionHostSshChannel(
  cfg: HostChannelPlanCfg & { hostSshPort: string },
): HostChannelProvision {
  const plan = plannedHostChannel(cfg);
  if (!plan) return { channel: null };
  const { candidates, keyPath } = plan;
  const port = toPort(cfg.hostSshPort) ?? HOST_CHANNEL_DEFAULT_PORT;
  try {
    mkdirSync(join(COMPOSE_DIR, "host-ssh"), { recursive: true, mode: 0o700 });
    if (!existsSync(keyPath)) {
      const g = spawnSync(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-q", "-f", keyPath, "-C", HOST_KEY_COMMENT],
        // stderr is captured rather than discarded: it is the only account of why the
        // channel is missing, and the caller prints it.
        { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
      );
      if (g.status !== 0) return { channel: null, issue: { code: "keygen", detail: keygenWhy(g) } };
    }
    const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
    if (!pub) return { channel: null, issue: { code: "empty-key" } };

    const tried: string[] = [];
    // Authorized this run and NOT settled on. Swept only once something else has been
    // proven to work — see the total-failure branch for why they can't be swept eagerly.
    const losers: HostChannelCandidate[] = [];
    let lastFailure: { state: "refused" | "forced-command"; detail: string } | null = null;

    for (const candidate of candidates) {
      tried.push(candidate.user);
      // The account's OWN file, always: a root invoker writes /root directly, a non-root
      // one writes its own home, and `$SUDO_USER`'s comes from the passwd database.
      // Nothing is ever authorized for an account we are not logging in as — which is what
      // collapsed the old write-goes-through-sudo distinction.
      authorizeKeyAt(candidate.authKeysPath, pub);

      // The key is authorized and `.env` is about to point the api at the host, but a key
      // is not a server: `ssh-keygen` is the openssh CLIENT and `authorized_keys` is just a
      // file, so every step above succeeds on a box with no sshd at all. Nothing to learn
      // from the other candidates either — this is the host, not the account.
      if (probeHostSshd(port) === "absent") {
        return { channel: { user: candidate.user, keyPath }, issue: { code: "no-sshd", detail: `port ${port}` } };
      }

      // And a LISTENER is not an accepted key. This is the check whose absence is #527, and
      // its verdict — not the uid we were invoked with — is what picks the account.
      const auth = verifyChannelAuth(candidate.user, keyPath, port);

      if (auth.state === "unreachable") {
        // The address is the problem, not the account, so trying the next one would
        // authorize a second key to learn the same thing.
        return {
          channel: { user: candidate.user, keyPath },
          issue: { code: "unreachable", detail: auth.detail },
        };
      }
      if (auth.state === "refused" || auth.state === "forced-command") {
        lastFailure = { state: auth.state, detail: auth.detail };
        losers.push(candidate);
        continue;
      }

      // Settled. `unknown` lands here too: an install with no `ssh` client can't be
      // verified either way, and failing it over a missing binary would be the opposite
      // mistake — so it is trusted, exactly as it was before there was a check at all.
      const elevation: HostChannelCandidate["elevation"] =
        candidate.user === "root"
          ? "login"
          : auth.state === "ok" && auth.elevation === "refused"
            ? // MEASURED, over the session shape the api will use. This is the arm
              // `hasPasswordlessSudo` used to get wrong from a cached ticket, which is what
              // suppressed the warning below on boxes that genuinely could not reach root.
              "none"
            : candidate.elevation;

      // Only now, with something proven to work, is it safe to take the others back. Each
      // one's dial was refused this run, so revoking it cannot remove working access.
      for (const loser of losers) revokeKeyAt(loser.authKeysPath);
      if (elevation === "sudo") {
        // Switching AWAY from root must not leave the old root key live — including a root
        // line an OLDER CLI wrote, which is not in `losers` because this run never tried
        // it. Gated on the MEASURED verdict, never the local probe: `revokeRootKeyViaSudo`
        // spends the same cached ticket that made the probe lie, so a ticket-only re-run
        // used to strip a working root grant and leave no route to root at all.
        revokeRootKeyViaSudo();
      }
      if (elevation === "none") {
        // #489's failure mode, now also reached by a non-root login whose sudo genuinely
        // doesn't work: host ops on root-owned paths (mail state under /root/.openship, the
        // edge, the recovery manifest) WILL fail. Keep the channel — non-root host ops
        // still work — but say so loudly.
        console.warn(
          "  ⚠ Host control needs root, and this channel has no route to it: it logs in as\n" +
            `    \`${candidate.user}\`, and \`sudo -n\` was refused over that session. Mail and edge\n` +
            "    host operations will fail. Grant that account passwordless sudo, or re-run\n" +
            "    `openship up` as root, to fix. Continuing with a limited host channel.",
        );
      }
      if (candidate.source === "sudo-user") {
        // An auto-migration changes which credential exists on the box, so it is announced
        // rather than left for an operator to notice in `.env`.
        console.log(
          `  → Host channel settled on \`${candidate.user}\` rather than root: this host refused a\n` +
            "    root login, and that account's key was accepted. It elevates per operation with\n" +
            "    sudo, so no standing root credential is created. Pin one with\n" +
            "    `openship up --host-ssh-user <name>`.",
        );
      }
      return { channel: { user: candidate.user, keyPath }, issue: undefined };
    }

    // Nothing worked. Every account we authorized this run had its dial refused, so their
    // lines grant nothing — but they are left in place ANYWAY when one of them is the
    // account `.env` already names, because materialize is about to carry that channel
    // forward (carriedHostChannel) and revoking its key would turn a fault the operator can
    // fix into a channel that has to be re-provisioned to work again.
    const carried = cfg.hostSshUserCarried?.trim();
    for (const loser of losers) {
      if (loser.user !== carried) revokeKeyAt(loser.authKeysPath);
    }
    return {
      channel: null,
      issue: {
        code: lastFailure?.state === "forced-command" ? "forced-command" : "auth-refused",
        ...(lastFailure?.detail ? { detail: lastFailure.detail } : {}),
        account: tried[tried.length - 1] ?? "",
        tried,
        ...(tried.includes("root")
          ? (() => {
              const setting = permitRootLoginSetting(port);
              return setting ? { permitRootLogin: setting } : {};
            })()
          : {}),
      },
    };
  } catch (err) {
    return { channel: null, issue: { code: "error", detail: (err as Error)?.message } };
  }
}

/**
 * What `sshd -T` reports for `PermitRootLogin`, or null when the question couldn't be
 * asked. ADVISORY ONLY — it never decides which account we use.
 *
 * Three reasons it can't be a verdict, all of which would make pruning a candidate on it a
 * bug rather than an optimization:
 *   - it prints the GLOBAL config, so a `Match Address` block that re-permits root from the
 *     docker bridge (a reasonable way to run this channel on a hardened box) doesn't show
 *     up, and `-C addr=127.0.0.1` can't stand in for it — the container dials the BRIDGE
 *     address, not loopback;
 *   - `prohibit-password` and its alias `without-password` both PERMIT publickey, and
 *     `sshd -T` normalizes one to the other, so the value that reads like a restriction is
 *     the Debian default and works fine;
 *   - it needs root, needs `/run/sshd` to exist, and exits 255 on any directive the local
 *     sshd doesn't recognize.
 * So the dial decides and this explains, which is also why a failure here is silent.
 */
function permitRootLoginSetting(port: number): string | null {
  try {
    const r = spawnSync(
      "sudo",
      ["-n", "sshd", "-T", "-C", `user=root,host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=${port}`],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return null;
    return /^permitrootlogin\s+(\S+)/m.exec(r.stdout ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * PURE. Does this `PermitRootLogin` value refuse our key channel?
 *
 * `yes`, `prohibit-password` and `without-password` all admit a publickey login, so only
 * two values are a refusal. Exported for tests because the wrong answer here is a message
 * that tells an operator to change a setting that was never the problem — and because
 * "anything but `yes`" is the intuitive rule and it is wrong twice over.
 */
export function sshdRefusesRootLogin(value: string | undefined | null): boolean {
  const v = value?.trim().toLowerCase();
  return v === "no" || v === "forced-commands-only";
}

/**
 * Can the api's per-operation elevation actually work as this account?
 *
 * Measured over the channel we just dialed rather than locally, because the two answer
 * different questions: `privilegedExecutor` elevates from a fresh, tty-less ssh session
 * with no sudo timestamp ticket, and a local probe runs in the operator's terminal, which
 * usually has one. `unknown` when the probe itself couldn't be read.
 */
type ElevationProbe = "ok" | "refused" | "unknown";

type ChannelAuthCheck =
  /** sshd accepted the key for this account. `elevation` is the same session's answer to
   *  whether `sudo -n` works there — see ElevationProbe. */
  | { state: "ok"; elevation: ElevationProbe }
  /**
   * We reached sshd and it would not log this account in with the key we just wrote.
   *
   * Deliberately NOT split into "key missing" vs "account refused": `Permission denied
   * (publickey)` is byte-identical for both (and for `DenyUsers`, an `AllowUsers` that
   * excludes the account, a `from=` mismatch, and a nonexistent account), and OpenSSH
   * withholds the difference on purpose. What narrows it is not ssh's stderr but the fact
   * that we just wrote the line ourselves — so the remedy names sshd's account policy and
   * the one command that shows it, instead of sending the operator to move key files.
   */
  | { state: "refused"; detail: string }
  /**
   * Auth SUCCEEDED and the session then died without running our probe — the
   * `PermitRootLogin forced-commands-only` shape (our line carries no `command=`), or a
   * login shell that can't execute a command. Kept apart from `refused` because "the host
   * refused the key" is false here and would send the operator to the wrong file.
   */
  | { state: "forced-command"; detail: string }
  /**
   * Never got as far as authentication: nothing accepted a connection at the address we
   * dialed. A `ListenAddress` that excludes loopback lands here, and reporting it as a key
   * refusal — which every non-zero ssh exit used to be — pointed at `authorized_keys` for
   * a host whose keys were never consulted.
   */
  | { state: "unreachable"; detail: string }
  /** The question could not be asked — no `ssh` client, or it never ran. Never reported
   *  as a refusal: failing an otherwise-good install over a missing binary would be the
   *  opposite mistake. */
  | { state: "unknown" };

/**
 * Does sshd actually ACCEPT this key for this account?
 *
 * Dialed at 127.0.0.1, not `host.docker.internal` — that name only resolves inside the
 * container, and it is not the half in question. This asks the one thing only sshd can
 * answer (is this key authorized for this user, and may this user log in at all); the
 * bridge half is what `probeHostSshd` and the firewall probe already cover.
 *
 * `BatchMode=yes` is load-bearing: without it a host that falls back to password auth
 * would sit at a prompt inside `openship up` forever. `UserKnownHostsFile=/dev/null`
 * keeps a verification dial from writing an entry for a host the operator never asked to
 * trust, and `PreferredAuthentications=publickey` stops a success arriving via some other
 * method — which would report the channel working when its key is not.
 */
function verifyChannelAuth(user: string, keyPath: string, port: number): ChannelAuthCheck {
  const r = spawnSync(
    "ssh",
    [
      "-v",
      "-i", keyPath,
      "-p", String(port),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5",
      "-o", "PreferredAuthentications=publickey",
      "-o", "IdentitiesOnly=yes",
      `${user}@127.0.0.1`,
      CHANNEL_PROBE_COMMAND,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
  );

  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || r.status === null) {
    return { state: "unknown" };
  }
  const stderr = r.stderr || "";
  const stdout = r.stdout || "";
  // The probe's own marker, not the exit code: the remote script ends in `exit 0` so that
  // a REFUSED sudo (an ordinary, non-fatal answer) can't be read as a failed login.
  const sudo = /openship-sudo=(ok|refused)/.exec(stdout)?.[1];
  if (r.status === 0 && sudo) {
    return { state: "ok", elevation: sudo === "ok" ? "ok" : "refused" };
  }
  // Authenticated, but the marker never arrived. Either the session was closed on us
  // (forced-commands-only) or the remote shell couldn't run it; both are a working key.
  if (/Authenticated to |debug1: Authentication succeeded/.test(stderr)) {
    return r.status === 0
      ? { state: "ok", elevation: "unknown" }
      : { state: "forced-command", detail: sshProbeDetail(stderr, r.status) };
  }
  // Never reached auth at all — a closed port, a firewall, or an sshd bound to an address
  // that isn't the one we dialed.
  if (/^ssh: connect to host/m.test(stderr)) {
    return { state: "unreachable", detail: sshProbeDetail(stderr, r.status) };
  }
  if (r.status === 0) return { state: "ok", elevation: "unknown" };
  return { state: "refused", detail: sshProbeDetail(stderr, r.status) };
}

/**
 * What the verification dial runs on the host.
 *
 * Two things in one round trip: proof the login works, and whether `sudo -n` works from
 * exactly the session shape the api uses (no tty, no inherited ticket — see
 * hasPasswordlessSudo for why a local probe cannot answer this). The trailing `exit 0` is
 * load-bearing: without it a refused sudo would exit non-zero and be indistinguishable
 * from a refused LOGIN, which is the confusion this whole classifier exists to remove.
 */
const CHANNEL_PROBE_COMMAND =
  "if sudo -n -k true 2>/dev/null; then echo openship-sudo=ok; " +
  "else echo openship-sudo=refused; fi; exit 0";

/**
 * The one line of ssh's output an operator needs, out of `-v`'s several dozen.
 *
 * `-v` is on because the post-auth markers are the only way to tell a key that was
 * ACCEPTED (and then had its session closed) from one that was refused — but its debug
 * stream would bury the actual cause, and `StrictHostKeyChecking=no` announces every first
 * contact on top of that. Both are dropped; what's left is the diagnosis.
 */
function sshProbeDetail(stderr: string, status: number | null): string {
  const detail = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^debug\d*:/.test(l) &&
        !/^OpenSSH_/.test(l) &&
        !/^Warning: Permanently added/.test(l),
    )
    .join(" ");
  return detail || `ssh exited ${status}`;
}

/** Why `ssh-keygen` didn't produce a key — a missing binary is the common one, and it
 *  reads as an exit code with no output unless it's named. */
function keygenWhy(r: { status: number | null; stderr?: string; error?: Error }): string {
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return "ssh-keygen is not installed — the openssh-client package provides it";
  }
  const stderr = (r.stderr ?? "").trim().split("\n").pop();
  return stderr || r.error?.message || `ssh-keygen exited ${r.status ?? "abnormally"}`;
}

/**
 * Is anything on this host listening for SSH?
 *
 * The channel's whole premise is that the api container can log into the host, and
 * nothing in provisioning tests that premise: it writes a key and a file. A box with no
 * SSH server — a minimal container-host image, an sshd that was never enabled — therefore
 * reported a fully provisioned channel and then failed every host operation, which is the
 * #509 shape one layer along from an unset env var.
 *
 * `absent` is claimed ONLY from a listener list we actually read; a listing we couldn't
 * get is `unknown` and says nothing, because a false "no sshd here" sends an operator to
 * fix a host that was fine. A socket-activated sshd still holds the listening socket
 * (systemd's `ssh.socket`), so it shows up here like any other.
 */
type SshdPresence = "listening" | "absent" | "unknown";

function probeHostSshd(port: number): SshdPresence {
  for (const [cmd, args] of [
    ["ss", ["-H", "-ltn"]],
    ["netstat", ["-ltn"]],
  ] as const) {
    const r = spawnSync(cmd, [...args], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) continue;
    return listensOnPort(r.stdout, port) ? "listening" : "absent";
  }
  return "unknown";
}

/**
 * PURE. Does an `ss -ltn` / `netstat -ltn` listing hold a LISTEN socket on `port`?
 *
 * Matched on a whole address column ending in `:<port>` so `:22` can never match `:2222`,
 * and only on rows that say LISTEN so the foreign-address column (`0.0.0.0:*`) and any
 * header can't be read as a listener. Exported for tests: a false negative here tells an
 * operator their working host has no SSH server.
 */
export function listensOnPort(listing: string, port: number): boolean {
  return listing
    .split("\n")
    .filter((line) => /\bLISTEN\b/.test(line))
    .some((line) =>
      line
        .trim()
        .split(/\s+/)
        .some((token) => token.endsWith(`:${port}`)),
    );
}

/**
 * The host channel this install ALREADY had, when provisioning failed this run.
 *
 * #509's quieter half: all five OPENSHIP_HOST_* keys are omittable-managed
 * (OMITTABLE_MANAGED_KEYS), so a run that produces no channel deletes them from `.env` —
 * and because `.env` then differs, compose force-recreates the api WITHOUT them. A
 * transient keygen failure therefore took host control off a box where it had worked for
 * months, in the same run that printed success. Carrying the previous values forward makes
 * a failure a no-op instead of a revocation; taking the channel away stays the job of
 * `--no-host-control`, which says so (retireHostSshChannel).
 *
 * Gated on the private key still being there, because the key IS the channel: an env
 * pointing OPENSHIP_HOST_KEY_PATH at a path with no file makes the daemon create a
 * DIRECTORY as the bind source, and the api then mounts a directory where it expects a
 * key. A channel whose key is gone is not one to carry.
 */
function carriedHostChannel(prev: Record<string, string>): { user: string; keyPath: string } | null {
  const keyPath = prev.OPENSHIP_HOST_KEY_PATH?.trim();
  if (!prev.OPENSHIP_HOST_SSH_HOST?.trim() || !keyPath || !existsSync(keyPath)) return null;
  return { user: hostChannelAccount(prev), keyPath };
}

const HOST_ISSUE_INDENT = "    ";

/** One note under the warning's headline, wrapped to a terminal. Explicit newlines survive
 *  (wrapText honours them), so a pasteable command inside core's prose stays whole. */
function hostIssueNote(text: string): string {
  return wrapText(text, 80)
    .map((l) => `${HOST_ISSUE_INDENT}${l}\n`)
    .join("");
}

/**
 * PURE. What `up` prints when this run left no working host channel (#509).
 *
 * The CAUSE is only ever visible here — see provisionHostSshChannel — so this is the one
 * surface that can name it. Everything AROUND the cause comes from @repo/core (what still
 * works, what doesn't, how to re-check) so the install log, the API's boot banner, the
 * dashboard banner and `openship doctor` read as one account of the same box rather than
 * four independent ones.
 *
 * Never fatal, and worded so: a degraded install is not a failed one.
 */
export function renderHostChannelIssue(
  issue: HostChannelIssue,
  ctx: {
    /** `host:port` the api container dials — the same target every other surface names. */
    target: string;
    /** The previous run's channel was carried forward, not revoked (carriedHostChannel). */
    kept: boolean;
  },
): string {
  const detail = issue.detail ? ` (${issue.detail})` : "";
  const headline =
    issue.code === "no-sshd"
      ? `  ⚠ Host control is provisioned, but nothing on this host is listening for SSH` +
        `${detail}.`
      : issue.code === "unreachable"
        ? `  ⚠ Host control is provisioned, but nothing answered at the SSH address we dialed` +
          `${detail}.`
        : issue.code === "forced-command"
          ? // Like `auth-refused` and unlike `no-sshd`: a key that can't run a command is
            // not a channel, so nothing was written and the headline must not imply it was.
            `  ⚠ Host control could NOT be provisioned: this host's sshd allows the channel no commands.`
          : issue.code === "auth-refused"
            ? // NOT "is provisioned, but": a refusal no longer leaves a channel behind. The
              // run tried every account it could authorize and none of them were let in, so
              // there is nothing provisioned to describe.
              `  ⚠ Host control could NOT be provisioned: this host REFUSED the channel's key.`
            : `  ⚠ Host control could NOT be provisioned on this box.`;

  let cause: string;
  switch (issue.code) {
    case "keygen":
      cause = `The channel's key could not be generated${detail}.`;
      break;
    case "empty-key":
      cause = "The channel's key was generated but its public half read back empty.";
      break;
    case "no-sshd":
      // The remedy is core's, for a refusal — which is what the api container is about to
      // hit: it now has a key and an address, and nothing at the other end. Quoting the
      // refusal rather than writing a second sshd remedy keeps this and the probe that
      // reports the same host from drifting apart.
      cause =
        `The api container now has a key and an address, and will be refused the first ` +
        `time it dials ${ctx.target}:\n` +
        explainHostChannelCause("refused", {
          target: ctx.target,
          // Measured here rather than left to core's default, which is Debian's `ssh` —
          // a unit name that does not exist on the RHEL family, so the remedy printed on
          // an Amazon Linux box was a command that silently does nothing.
          sshdEnableHint: thisHost().sshdEnableHint(),
        }).body;
      break;
    case "unreachable":
      // A listener exists (probeHostSshd said so) and yet the dial never reached auth, so
      // the one thing this cannot be is the key — which is what it used to be reported as.
      cause =
        `sshd is listening on this host, but the verification dial to 127.0.0.1 was not ` +
        `answered${detail}. That is an ADDRESS problem, not a key problem: a ` +
        `\`ListenAddress\` that excludes loopback, or a local firewall rule. The api ` +
        `container dials ${ctx.target}, so check that sshd accepts connections there — ` +
        `\`sudo sshd -T | grep -i listenaddress\` shows what it binds.`;
      break;
    case "forced-command":
      cause =
        `sshd ACCEPTED the channel's key for \`${issue.account ?? "the channel account"}\` ` +
        `and then closed the session without running anything${detail}. That is what ` +
        `\`PermitRootLogin forced-commands-only\` does to a key with no \`command=\` of its ` +
        `own, and it is indistinguishable from a working channel until a host operation ` +
        `runs. Either permit this account a normal login, or use an account that has one: ` +
        `\`openship up --host-ssh-user <name>\`.`;
      break;
    case "auth-refused": {
      // The one cause here an operator can act on immediately, so it names the accounts we
      // tried and the three things that actually fix it — #527's reporter had none of that,
      // and spent a dozen messages moving key files that were never read.
      const accounts = issue.tried?.length
        ? issue.tried.map((a) => `\`${a}\``).join(" then ")
        : `\`${issue.account ?? "the channel account"}\``;
      // Only ever a quote of what sshd reported, never our own inference — see
      // permitRootLoginSetting for why the dial and this value can legitimately disagree.
      const rootNote = issue.permitRootLogin
        ? ` This host's sshd reports \`PermitRootLogin ${issue.permitRootLogin}\`` +
          `${sshdRefusesRootLogin(issue.permitRootLogin) ? ", which refuses a root login outright" : ""}.`
        : "";
      cause =
        `The key was authorized for ${accounts} and sshd is listening, but every dial was ` +
        `refused${detail}.${rootNote} sshd is not telling us which of several causes it is — ` +
        `\`Permission denied (publickey)\` is the same message for an account that may not ` +
        `log in, an \`authorized_keys\` sshd doesn't read for it, and a home directory whose ` +
        `permissions it rejects. Three things fix it:\n` +
        `  • name an account that CAN log in: \`openship up --host-ssh-user <name>\`\n` +
        `  • permit root a key login: \`PermitRootLogin prohibit-password\` (still refuses ` +
        `passwords), or scope it to the container with a \`Match Address\` block\n` +
        `  • or leave host control off: \`openship up --no-host-control\`\n` +
        `Until one of them is done the api container will be refused every time it dials ` +
        `${ctx.target}.`;
      break;
    }
    case "error":
      cause = `Setting up the channel's key failed${detail}.`;
      break;
  }

  // Silent for the codes that still leave a channel in `.env` — there is nothing to carry
  // or unset, so both halves of this note would be false. That is exactly the two host-level
  // faults: no sshd at all, and an sshd that didn't answer at this address. `auth-refused`
  // and `forced-command` are NOT here — neither returns a channel any more, so an operator
  // whose working install just lost one (or kept the old one) has to be told which.
  const continuity =
    issue.code === "no-sshd" || issue.code === "unreachable"
      ? ""
      : ctx.kept
        ? hostIssueNote(
            "Kept the host channel this install already had in `.env` rather than dropping it: " +
              "its key is still authorized, so the api container keeps the access it had " +
              "instead of losing it to this failure.",
          )
        : hostIssueNote(
            "OPENSHIP_HOST_SSH_HOST is therefore unset, and host operations refuse rather " +
              "than run against the api container's own filesystem.",
          );

  return (
    `${headline}\n` +
    hostIssueNote(cause) +
    continuity +
    hostIssueNote(HOST_CHANNEL_UNAFFECTED) +
    `${HOST_ISSUE_INDENT}Unavailable until the channel works:\n` +
    HOST_CHANNEL_BLOCKED.map((l) => `${HOST_ISSUE_INDENT}  · ${l}\n`).join("") +
    hostIssueNote(HOST_CHANNEL_RECHECK)
  );
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

const PGDATA_ROOT = "/var/lib/postgresql/data";

/**
 * Where an existing data volume actually keeps its cluster, read from the volume
 * itself rather than guessed at.
 *
 * `PG_VERSION` sits at the top of a Postgres cluster directory, so whether it's at
 * `/from` or `/from/pgdata` tells us which layout an existing install used — the
 * only sound basis for OPENSHIP_PGDATA on a volume this run didn't create (#487). A
 * throwaway read-only container is the only way to read a named volume's contents
 * (same idiom as migrateEdgeState above). `lost+found` is filtered from the
 * emptiness check: Docker provisions a fresh ext4 volume with exactly that one
 * entry, and without the filter a genuinely-fresh install would read as `foreign`
 * and be wrongly blocked by the gate below.
 *
 *   root    — cluster at the mount root (a pre-#350 install)
 *   sub     — cluster in the pgdata/ subdir (every install since #350)
 *   empty   — no cluster, safe to initdb (fresh volume)
 *   foreign — non-empty but no cluster we recognize — refuse rather than guess
 *   unknown — docker/daemon unavailable — never guess
 */
type PgProbe = "root" | "sub" | "empty" | "foreign" | "unknown";
function probePgDataDir(volume: string): PgProbe {
  const r = spawnSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${volume}:/from:ro`,
      "alpine:3", "sh", "-c",
      "if [ -f /from/PG_VERSION ]; then echo root; " +
        "elif [ -f /from/pgdata/PG_VERSION ]; then echo sub; " +
        "elif [ -z \"$(ls -A /from 2>/dev/null | grep -v '^lost+found$')\" ]; then echo empty; " +
        "else echo foreign; fi",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "unknown";
  const out = `${r.stdout ?? ""}`.trim();
  return out === "root" || out === "sub" || out === "empty" || out === "foreign" ? out : "unknown";
}

/**
 * Where Postgres keeps its data directory INSIDE the `postgres_data` volume.
 *
 * A fresh install uses a subdirectory (`…/data/pgdata`) rather than the bare
 * mount root: initdb against a mount root fails on quirky host filesystems with
 * "Operation not permitted" (WAL preallocation / lost+found — see #350). But a
 * pre-existing install may have its DB at the mount ROOT, and moving PGDATA would
 * make Postgres init a fresh empty DB and orphan the old one. So the decision is
 * made ONCE and then pinned in `.env` (same sticky rule as COMPOSE_PROJECT_NAME):
 * re-runs reuse it.
 *
 * On the ONE run where a volume exists but the key isn't pinned yet — an upgrade
 * from a version that never persisted it, or a restored/unreadable `.env` — we
 * must READ the volume, not guess from its mere existence. The old heuristic
 * ("volume exists → root") wrote the root while the cluster was really in the
 * subdir, so Postgres ran initdb over a non-empty dir and the whole stack died
 * (#487). Take the root ONLY when PG_VERSION is actually there; anything else
 * resolves to the subdir (the compose default and how every install since #350
 * was created), and the `foreign` case is stopped by the gate before it matters.
 */
function resolvePgData(prev: Record<string, string>): string {
  const SUB = `${PGDATA_ROOT}/pgdata`;
  if (prev.OPENSHIP_PGDATA) return prev.OPENSHIP_PGDATA; // decided already — never move it
  const volume = survivingDbVolume(prev);
  if (!volume) return SUB; // fresh install → compose default
  return probePgDataDir(volume) === "root" ? PGDATA_ROOT : SUB;
}

/**
 * #487: a data volume this run didn't create holds data we don't recognize — no
 * cluster at the root or the pgdata/ subdir, but not empty either. Writing a
 * guessed OPENSHIP_PGDATA here is how #487 destroyed installs, so callers stop and
 * make the operator pin the path themselves. Non-null ONLY for the `foreign` probe
 * result; `root`/`sub`/`empty`/`unknown` are all handled safely by resolvePgData.
 */
function pgDataDetectionRisk(prev: Record<string, string>): { volume: string } | null {
  if (prev.OPENSHIP_PGDATA) return null; // already pinned — resolvePgData won't probe
  const volume = survivingDbVolume(prev);
  if (!volume) return null;
  return probePgDataDir(volume) === "foreign" ? { volume } : null;
}

/**
 * The same check against the `.env` on disk, for callers that must stop BEFORE
 * anything writes it — mirrors composeSecretRotationRisk. The probe runs only on
 * the rare transition run (volume present, key unpinned); once OPENSHIP_PGDATA is
 * written every future run short-circuits in resolvePgData/pgDataDetectionRisk, so
 * paying for one extra `docker run` on that single run needs no memoization.
 */
export function composePgDataRisk(_opts: ComposeUpOpts = {}): { volume: string } | null {
  // No opt waives this — unlike --reset-secrets for the rotation gate, "reset the secrets"
  // is not consent to guess where the cluster lives. The escape hatch is pinning the path.
  return pgDataDetectionRisk(readEnvFile());
}

/**
 * What to tell the operator when `up` refuses to write a guessed OPENSHIP_PGDATA.
 * Shared with the dry run (same reason as renderSecretRotationRefusal) so the
 * preview and the real run describe this state identically. Names the volume, both
 * candidate paths, and the one-line escape hatch — pinning the key by hand.
 */
export function renderPgDataRefusal(
  risk: { volume: string },
  opts: { dryRun?: boolean } = {},
): string {
  const SUB = `${PGDATA_ROOT}/pgdata`;
  return (
    `\n  ${opts.dryRun ? "A real run would REFUSE here" : "Refusing to continue"}:` +
    ` this install's data volume holds data, but not a Postgres cluster we recognize.\n\n` +
    `    volume:  ${risk.volume}\n` +
    `    checked: ${PGDATA_ROOT}/PG_VERSION and ${SUB}/PG_VERSION — neither present\n\n` +
    `  Guessing where the cluster lives is how a wrong path makes Postgres run initdb over\n` +
    `  your existing data and orphan it, so nothing has been written. If you know the layout,\n` +
    `  pin it and re-run:\n\n` +
    `    echo 'OPENSHIP_PGDATA=${SUB}' >> ${ENV_FILE}     # or ${PGDATA_ROOT} if the cluster is at the root\n`
  );
}

/**
 * One `docker ps -a` row per container: its name, its compose project, the compose
 * FILES it was created from, and its compose service.
 *
 * One format for every label reader in this file — orphaned stacks, the stray-edge
 * reclaim, and the adopted-stack evidence the secret-rotation refusal needs. They ask
 * the same question of the same rows, and three copies of this format string is how one
 * of them ends up reading a column the others moved.
 */
const PS_SWEEP_FORMAT =
  '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.config_files"}}\t{{.Label "com.docker.compose.service"}}';

interface PsRow {
  name: string;
  project: string;
  /** Comma-separated (base + build override) — compare per entry, never whole. */
  configFiles: string;
  service: string;
}

/** PURE. The sweep's rows. Tolerates the older 3-column form (no service label). */
function parsePsSweep(stdout: string): PsRow[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, project, configFiles, service] = line.split("\t");
      return {
        name: name ?? "",
        project: project ?? "",
        configFiles: configFiles ?? "",
        service: service ?? "",
      };
    });
}

/** The sweep as docker printed it, or null when docker can't be asked. */
function psSweepRaw(): string | null {
  const r = spawnSync("docker", ["ps", "-a", "--format", PS_SWEEP_FORMAT], { encoding: "utf8" });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/** Every container on the box, or [] when docker can't be asked. */
function psSweep(): PsRow[] {
  return parsePsSweep(psSweepRaw() ?? "");
}

/** Was this container created from the compose file we generate? */
function fromOurComposeFile(row: { configFiles: string }): boolean {
  return row.configFiles.split(",").some((f) => f.trim() === COMPOSE_FILE);
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
  return psSweep()
    .filter((c) => c.name && c.project && c.project !== project && fromOurComposeFile(c))
    .map(({ name, project: proj }) => ({ name, project: proj }));
}

/**
 * PURE. Evidence that the stack under `project` is one we did NOT create — so a run
 * that reuses its volumes is ADOPTING it.
 *
 * `docker/docker-compose.yml` pins `name: openship`, the same project name this CLI
 * pins, so the two stacks collide by design: same container names, same
 * `openship_postgres_data`. Compose's own labels are the evidence — rows under our
 * project name whose `config_files` names some OTHER compose file (or names nothing at
 * all, a label-less `docker run`). One row created from OUR file means the stack is
 * ours (compose relabels what it adopts), so nothing is reported.
 *
 * The api container is named from its `service` label rather than guessed, because the
 * refusal tells the operator to read the secrets out of its environment; compose's own
 * default naming is the fallback for rows that carry no service label.
 *
 * Exported for tests: the whole point is to distinguish two states that look identical
 * on disk, and getting it backwards sends an operator to `--reset-secrets`.
 */
export function adoptedStackOrigin(
  psStdout: string,
  project: string,
): { project: string; configFiles: string; apiContainer: string } | null {
  const rows = parsePsSweep(psStdout).filter((c) => c.name && c.project === project);
  if (rows.length === 0 || rows.some(fromOurComposeFile)) return null;
  return {
    project,
    configFiles: rows.map((c) => c.configFiles).find(Boolean) ?? "",
    apiContainer: rows.find((c) => c.service === "api")?.name || `${project}-api-1`,
  };
}

function adoptedStack(
  project: string,
): { project: string; configFiles: string; apiContainer: string } | null {
  const sweep = psSweepRaw();
  return sweep ? adoptedStackOrigin(sweep, project) : null;
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
/**
 * From a `docker ps -a` sweep (see PS_SWEEP_FORMAT), whether a stray `openship-edge`
 * must be force-removed before `up`: it exists AND is not owned by THIS compose
 * project (same project name AND our compose file among the config files). No such
 * row → false. Pure, so the decision is unit-tested directly.
 */
export function edgeNameNeedsReclaim(psStdout: string, project: string): boolean {
  const row = parsePsSweep(psStdout).find((c) => c.name === "openship-edge");
  if (!row) return false; // no such container — nothing in the way
  return !(row.project === project && fromOurComposeFile(row));
}

function reconcileEdgeContainerName(project: string): void {
  const sweep = psSweepRaw();
  if (!sweep) return;
  if (!edgeNameNeedsReclaim(sweep, project)) return;
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

/**
 * The `host.docker.internal` mapping, when the operator set one — shell over
 * `.env`, same as the ACME keys, and omitted entirely otherwise so the compose
 * template's `host-gateway` fallback stays in charge of the default.
 */
function hostGatewayEnv(prev: Record<string, string>): string[] {
  const value = process.env.OPENSHIP_HOST_GATEWAY?.trim() || prev.OPENSHIP_HOST_GATEWAY?.trim();
  return value ? [`OPENSHIP_HOST_GATEWAY=${value}`] : [];
}

/**
 * Where a ROOTLESS daemon's socket lives, in the order worth trying — each one
 * existence-checked by the caller, so a wrong guess costs nothing.
 *
 * `$SUDO_UID` is not redundant with `userInfo()`: under `sudo openship up` both
 * `$XDG_RUNTIME_DIR` and the passwd entry describe ROOT, and /run/user/0 is not
 * where the operator's rootless daemon is — the sudo trap plannedHostChannel and
 * elevatedExecutor's owner lookup already work around.
 */
function rootlessSocketCandidates(): string[] {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  const sudoUid = process.env.SUDO_UID?.trim();
  let uid: number | undefined;
  try {
    uid = userInfo().uid;
  } catch {
    /* no passwd entry — the two env-derived candidates are all we have */
  }
  return [
    ...(runtimeDir ? [join(runtimeDir, "docker.sock")] : []),
    ...(sudoUid ? [`/run/user/${sudoUid}/docker.sock`] : []),
    ...(uid !== undefined ? [`/run/user/${uid}/docker.sock`] : []),
  ];
}

/**
 * The HOST path of the Docker socket to mount into the api container, DETECTED.
 *
 * The docker CLI's own answer comes first, and that ordering is the point: `up`
 * drives this install by shelling out to `docker compose`, so the api must get the
 * socket of the daemon the CLI is already talking to — not whatever happens to sit
 * at the rootful path. `resolveLocalDockerSocketPath` reads $DOCKER_HOST and the
 * active docker context, which is how Colima / Rancher / Podman / rootless all
 * advertise themselves, and is the same resolver the api uses for this question.
 *
 * A daemon that advertises itself NOWHERE still has to be found — the rootless case
 * in #482, where the setup tool's `export DOCKER_HOST` lives in a shell profile no
 * sudo or systemd invocation ever read. So take the rootful default only if that
 * socket is actually there, and probe the rootless runtime dirs first if it isn't.
 */
function detectDockerSocketPath(): string {
  const fromClient = resolveLocalDockerSocketPath(undefined, process.env);
  if (fromClient !== DEFAULT_DOCKER_SOCKET_PATH) return fromClient;
  if (existsSync(DEFAULT_DOCKER_SOCKET_PATH)) return DEFAULT_DOCKER_SOCKET_PATH;
  return rootlessSocketCandidates().find((p) => existsSync(p)) ?? DEFAULT_DOCKER_SOCKET_PATH;
}

/** The socket this run mounts, and whether an operator pinned it rather than us detecting it. */
function resolveDockerSocket(prev: Record<string, string>): { path: string; pinned: boolean } {
  const pinned = process.env.OPENSHIP_DOCKER_SOCKET?.trim() || prev.OPENSHIP_DOCKER_SOCKET?.trim();
  return pinned ? { path: pinned, pinned: true } : { path: detectDockerSocketPath(), pinned: false };
}

/**
 * `OPENSHIP_DOCKER_SOCKET` for this run, or nothing.
 *
 * A PINNED value always round-trips (shell over `.env`): half of #482 was that every
 * `openship up` rewrote a hand-fixed `.env` back to the value that didn't work. A
 * DETECTED default is omitted, so the template's `:-/var/run/docker.sock` stays the
 * one place the default lives and nothing pins a path a later daemon change breaks.
 *
 * Deliberately NOT in OMITTABLE_MANAGED_KEYS: it round-trips whenever set, so the run
 * that omits it is exactly the run where `.env` didn't have it to carry.
 *
 * And deliberately not spelled `DOCKER_HOST`: `.env` is injected into the api
 * container, where dockerode reads that variable — a HOST path there is a path the
 * container doesn't have. Only the compose file consumes this key.
 */
function dockerSocketEnv(prev: Record<string, string>): string[] {
  const { path, pinned } = resolveDockerSocket(prev);
  return pinned || path !== DEFAULT_DOCKER_SOCKET_PATH ? [`OPENSHIP_DOCKER_SOCKET=${path}`] : [];
}

/**
 * Say so when the socket this run is about to mount isn't on the box.
 *
 * Docker creates a missing bind source as a DIRECTORY, so nothing fails at `up` time
 * — the stack comes up healthy, `/api/system/check` 502s, and the api log carries a
 * transport error ("Was there a typo in the url or port?") naming no path at all,
 * which is how #482 was reported. A warning rather than a refusal: detection can be
 * wrong in ways an operator's `.env` fixes, and `openship update` on a live box must
 * not become unrunnable over it.
 */
function warnMissingDockerSocket(path: string): void {
  console.warn(
    `\n  ! The Docker socket this install mounts into the api isn't there:\n` +
      `      ${path}\n` +
      `    Docker will create that path as an empty DIRECTORY, so the stack will come up\n` +
      `    and then fail every container operation with a transport error naming neither\n` +
      `    this path nor the cause (#482). Point it at the real socket:\n` +
      `      docker context inspect --format '{{.Endpoints.docker.Host}}'\n` +
      `      OPENSHIP_DOCKER_SOCKET=/run/user/$(id -u)/docker.sock openship up --compose\n` +
      `    (a rootless daemon keeps its socket under the daemon user's runtime dir).\n`,
  );
}

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
  /** Which shell the dashboard defaults to (Openship Mail vs the full platform). */
  productMode: "platform" | "mail";
  /** Where the api container reaches this machine's sshd for host ops. */
  hostSshHost: string;
  hostSshPort: string;
  /** Operator-pinned host account (`--host-ssh-user`), if any. */
  hostSshUser?: string;
  /** The account the previous run settled on — continuity, not a pin. */
  hostSshUserCarried?: string;
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
    // Sticky too: `--mail` is only the install-time default, so a plain re-run
    // (or `openship update`) must not hand a mail box back the platform shell.
    // Turning it OFF is the dashboard's job — Settings → Instance stores the mode
    // in the database, which wins over this env var either way.
    productMode: opts.mail || keepConfig(prev, "OPENSHIP_PRODUCT") === "mail" ? "mail" : "platform",
    // Sticky like every other operator choice here. These were literals in
    // `renderEnv`, so a box where `host.docker.internal:22` is simply not the
    // right address — rootless Docker, sshd on another port — had nowhere to say
    // so, and every `openship up` overwrote a hand-edited `.env` back to the
    // value that didn't work (#490/#482).
    hostSshHost:
      keepConfig(prev, "OPENSHIP_HOST_SSH_HOST", opts.hostSshHost) ?? HOST_CHANNEL_DEFAULT_HOST,
    hostSshPort:
      keepConfig(prev, "OPENSHIP_HOST_SSH_PORT", opts.hostSshPort) ??
      String(HOST_CHANNEL_DEFAULT_PORT),
    // Sticky like its siblings, but kept in its OWN key rather than reusing
    // OPENSHIP_HOST_SSH_USER. That key records what provisioning SETTLED on, and the two
    // must not be conflated: reading a settled value back as a pin would freeze the account
    // a box happens to have — including the refused `root` on every install #527 broke — and
    // the fallback that repairs them could never run.
    ...(keepConfig(prev, "OPENSHIP_HOST_SSH_USER_PIN", opts.hostSshUser)
      ? { hostSshUser: keepConfig(prev, "OPENSHIP_HOST_SSH_USER_PIN", opts.hostSshUser) }
      : {}),
    ...(prev.OPENSHIP_HOST_SSH_USER?.trim()
      ? { hostSshUserCarried: prev.OPENSHIP_HOST_SSH_USER.trim() }
      : {}),
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
 * The container→host SSH endpoint the live install is CONFIGURED with, or null.
 *
 * Read back out of `.env` rather than taken from `plannedHostChannel`, because the
 * preflight's job is to verify what was actually written: a keygen that succeeded
 * and a channel that works are different claims, and #490 is the gap between them.
 */
export function composeHostChannel(): { host: string; port: number; user: string } | null {
  const env = readEnvFile();
  const host = env.OPENSHIP_HOST_SSH_HOST?.trim();
  if (!host) return null;
  return {
    host,
    port: toPort(env.OPENSHIP_HOST_SSH_PORT) ?? 22,
    user: hostChannelAccount(env),
  };
}

/**
 * Does this box WANT a container→host channel it hasn't got?
 *
 * `composeHostChannel()` returning null covers three different boxes, and only one of
 * them is a fault:
 *
 *   - no compose install at all — bare, so LocalExecutor IS the host;
 *   - a compose install hardened with `--no-host-control` — an operator's choice;
 *   - a compose install whose provisioning FAILED — #509, where every host operation
 *     dies against the api container's own filesystem and nothing said so.
 *
 * `provisionHostSshChannel` is best-effort, so the third case looked identical to the
 * first two: a null channel, and every reader concluding "nothing to check here". It now
 * warns at install time (renderHostChannelIssue), but that line is gone the moment the
 * terminal scrolls — a later reader still needs to work it out from disk. This is the
 * difference, read off two facts there: the compose file (the same "is there an install
 * here" test composeDown/composeUninstall use) and OPENSHIP_HOST_CONTROL, which renderEnv
 * writes on every run, true or false.
 *
 * Not `readInstallMethod()`: nothing ever writes `bare`, so that marker stays `compose`
 * on a box converted the other way and would answer no better here.
 */
export function composeHostChannelExpected(): boolean {
  if (!existsSync(COMPOSE_FILE)) return false;
  return readEnvFile().OPENSHIP_HOST_CONTROL !== "false";
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

/**
 * Managed keys renderEnv can emit but legitimately OMITS from some runs: the host channel
 * and the derived TRUST_PROXY. They are produced by the CLI, never authored by an operator,
 * so a run that omits one must DROP it — not carry it forward as operator config the way the
 * passthrough below does for unknown keys. Every OTHER managed key is either always emitted,
 * or round-tripped verbatim from `.env` (keepConfig) whenever it is present, so it can't
 * reach the passthrough.
 *
 * "Omits the host channel" is a NARROWER set than it looks, and that narrowing is #509's
 * second half: `--no-host-control` withdraws the channel deliberately (and says so), and a
 * platform that can't have one never had it. A provisioning FAILURE does not omit these keys
 * at all any more — materialize carries the previous values forward, because dropping them
 * here revokes a working channel and recreates the api without it.
 */
const OMITTABLE_MANAGED_KEYS: ReadonlySet<string> = new Set([
  "OPENSHIP_HOST_SSH_HOST",
  "OPENSHIP_HOST_SSH_USER",
  "OPENSHIP_HOST_SSH_USER_PIN",
  "OPENSHIP_HOST_SSH_PORT",
  "OPENSHIP_HOST_SSH_KEY",
  "OPENSHIP_HOST_KEY_PATH",
  "OPENSHIP_HOST_GATEWAY",
  "TRUST_PROXY",
]);

const envKeyOf = (line: string): string | undefined => line.match(/^([A-Z0-9_]+)=/)?.[1];

/**
 * #485: `openship up` regenerated `.env` from a fixed key list, so any variable an
 * operator had added by hand — OPENSHIP_AUTH_MODE, and anything bespoke — was dropped on
 * the next run or upgrade, silently and with no diff. Every documented "add this to your
 * `.env`" workaround therefore lasted exactly until the next `up`.
 *
 * PURE. Given the keys the writer emits THIS run (`managed`) and the previous `.env`,
 * return the `KEY=value` lines for everything the CLI does NOT own — verbatim, in the
 * file's own order — so regenerating the file preserves operator config instead of
 * erasing it. A key the writer emitted, or a managed key it may legitimately omit
 * (OMITTABLE_MANAGED_KEYS), belongs to the CLI and is never carried here.
 *
 * Exported for tests: this decides what survives a regenerate, so it's verified directly.
 */
export function operatorEnvPassthrough(
  managed: ReadonlySet<string>,
  prev: Record<string, string>,
): string[] {
  return Object.entries(prev)
    .filter(([key]) => !managed.has(key) && !OMITTABLE_MANAGED_KEYS.has(key))
    .map(([key, value]) => `${key}=${value}`);
}

const PRESERVED_ENV_HEADER =
  "# Preserved from your existing .env — set by you, not by `openship up` (#485).";

/**
 * The image tag the stack pins THIS run. An explicit `--image-version` wins; then
 * `OPENSHIP_VERSION` from the environment — the operator's escape hatch when the CLI
 * reached npm ahead of its images reaching the registry (#486), which no flag or env
 * var used to be able to redirect; then the CLI's own version; then `latest`.
 *
 * Deliberately NOT carried from the previous `.env`: `openship update` repins by
 * bumping exactly this key, and a plain re-run tracking the CLI's version is the
 * intent. The escape hatch is a one-shot override, not a sticky pin.
 */
export function resolveImageVersion(opts: ComposeUpOpts): string {
  return (
    opts.version?.trim() ||
    process.env.OPENSHIP_VERSION?.trim() ||
    (typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "latest")
  );
}

/**
 * The `.env` lines the CLI OWNS, regenerated verbatim every run. The keys emitted here
 * ARE the managed set (see operatorEnvPassthrough) — so adding a key to this list also,
 * by construction, stops it being mistaken for operator config on the next run.
 */
function managedEnvLines(
  opts: ComposeUpOpts,
  host: { user: string; keyPath: string } | null,
  cfg: ReturnType<typeof resolveEnvConfig>,
  prev: Record<string, string>,
): string[] {
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
    // The host side of the api's docker socket mount, when it isn't the rootful
    // default. Unlike the host channel above this is NOT optional plumbing — every
    // deploy goes through it — so it is resolved on every run, host control or not.
    ...dockerSocketEnv(prev),
    // Which shell the dashboard defaults to. Emitted on EVERY run, including the
    // "platform" default: that keeps the key permanently in the managed set, so
    // the #485 passthrough can never mistake it for operator config (which would
    // pin it and make the Settings → Instance toggle look broken after an `up`).
    `OPENSHIP_PRODUCT=${cfg.productMode}`,
    `OPENSHIP_IMAGE_REGISTRY=${cfg.registry}`,
    `OPENSHIP_VERSION=${resolveImageVersion(opts)}`,
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
      `OPENSHIP_HOST_SSH_HOST=${cfg.hostSshHost}`,
      // What provisioning SETTLED on this run — a fact about the box, not a setting. The
      // operator's pin, when there is one, is written OUTSIDE this block (see below).
      `OPENSHIP_HOST_SSH_USER=${host.user}`,
      `OPENSHIP_HOST_SSH_PORT=${cfg.hostSshPort}`,
      "OPENSHIP_HOST_SSH_KEY=/run/secrets/openship_host_key",
      `OPENSHIP_HOST_KEY_PATH=${host.keyPath}`,
      // What `host.docker.internal` resolves to inside the container. Carried from
      // the shell or the previous `.env` (never defaulted — an unset value lets the
      // compose template's `host-gateway` fallback apply).
      ...hostGatewayEnv(prev),
    );
  }
  // The operator's pinned account, OUTSIDE the `if (host)` above on purpose: it is a
  // setting, not a property of a channel that got provisioned. A pin whose account sshd
  // refuses produces no channel at all — and dropping the pin on exactly that run would
  // lose it the moment it mattered, so the next `up` (after the operator fixed sshd) would
  // re-decide from scratch and land back on the account they had ruled out.
  if (cfg.hostSshUser) lines.push(`OPENSHIP_HOST_SSH_USER_PIN=${cfg.hostSshUser}`);
  return lines;
}

/**
 * The `.env` body: the managed keys, then any operator-set keys carried across the
 * regenerate (#485). Returns the carried key names too, so a real run can say what it
 * kept rather than leaving the (previously destructive) rewrite silent.
 */
function renderEnvAndCarried(
  opts: ComposeUpOpts,
  host: { user: string; keyPath: string } | null,
  cfg: ReturnType<typeof resolveEnvConfig>,
  prev: Record<string, string>,
): { text: string; carried: string[] } {
  const lines = managedEnvLines(opts, host, cfg, prev);
  const managed = new Set(lines.map(envKeyOf).filter((k): k is string => !!k));
  const preserved = operatorEnvPassthrough(managed, prev);
  const body = preserved.length ? [...lines, "", PRESERVED_ENV_HEADER, ...preserved] : lines;
  return {
    text: body.join("\n") + "\n",
    carried: preserved.map((line) => line.slice(0, line.indexOf("="))),
  };
}

function renderEnv(
  opts: ComposeUpOpts,
  host: { user: string; keyPath: string } | null,
  cfg: ReturnType<typeof resolveEnvConfig>,
): string {
  return renderEnvAndCarried(opts, host, cfg, readEnvFile()).text;
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
  // --no-host-control: never generate/authorize a host key in the first place, and on a
  // box that already had one, take it back rather than only stopping short of using it —
  // otherwise the flag reads as "off" while the credential is still on disk and still
  // authorized. Resolved through cfg so a plain re-run keeps the install's choice.
  const provision = provisionHostSshChannel(cfg);
  let host = provision.channel;
  // #509: a provisioning FAILURE must not silently REVOKE a channel that already worked.
  // An `issue` here is the discriminated case that matters — host control ON, a platform
  // that can have a channel, and nothing to show for it — so it is both what carries the
  // old values forward and what gets said out loud.
  let kept = false;
  if (!host && provision.issue) {
    const previousChannel = carriedHostChannel(prev);
    if (previousChannel) {
      host = previousChannel;
      kept = true;
    }
  }
  if (!cfg.hostControl) retireHostSshChannel(prev);
  // Printed on the run's FIRST materialize only. One `up` materializes twice (see
  // ComposePrefetchResult) and `alreadyFetched` is exactly "the prefetch already did one",
  // so keying on it says this once rather than printing a dozen lines twice over.
  if (provision.issue && !opts.alreadyFetched) {
    console.warn(
      renderHostChannelIssue(provision.issue, {
        target: `${cfg.hostSshHost}:${cfg.hostSshPort}`,
        kept,
      }),
    );
  }
  // Same once-per-run gate, same reason (one `up` materializes twice).
  const socket = resolveDockerSocket(prev);
  if (!opts.alreadyFetched && !existsSync(socket.path)) warnMissingDockerSocket(socket.path);
  let before = "";
  try {
    before = readFileSync(ENV_FILE, "utf8");
  } catch {
    /* first install — no previous env, so everything is "changed" */
  }
  const { text: rendered, carried } = renderEnvAndCarried(opts, host, cfg, prev);
  writeFileSync(COMPOSE_FILE, renderComposeYaml());
  writeEnvFile(rendered, before);
  // #485: the old rewrite silently DROPPED operator-set keys. Now they survive — say so,
  // so a run that kept them doesn't look like it might have discarded them.
  if (carried.length) {
    console.log(`  Kept ${carried.length} operator-set .env variable(s): ${carried.join(", ")}`);
  }

  const buildDir = opts.build === false ? null : sourceBuildDir();
  if (buildDir) writeFileSync(BUILD_FILE, renderBuildOverride(buildDir));
  // `before === ""` is a first install: the containers don't exist yet and will be
  // created with this env, so there is nothing to force.
  return { buildDir, cfg, envChanged: before !== "" && rendered !== before };
}

/**
 * Replace `.env`, keeping the bytes it had.
 *
 * Two hazards, both #488. A plain `writeFileSync` truncates first, so an interrupt
 * mid-write (Ctrl-C, OOM, full disk) leaves a file that still PARSES — just without the
 * later keys, POSTGRES_PASSWORD and BETTER_AUTH_SECRET among them — and the next run
 * reads that as "no secrets yet". Writing a temp file and renaming it makes `.env` only
 * ever the old bytes or the new ones. And because the file is the only copy of this
 * install's generated secrets, the previous version is kept beside it: by the time a bad
 * rotation shows itself (an api that can't authenticate, environment variables that
 * won't decrypt) the original is otherwise already gone.
 *
 * A render identical to what's on disk writes nothing at all. One run materializes twice
 * (see ComposePrefetchResult), and without this the second pass replaced that recovery
 * copy with a copy of the FIRST pass's own write — leaving `.env.bak` a duplicate of
 * `.env` and the pre-run secrets gone, which is precisely the loss it exists to prevent.
 */
function writeEnvFile(rendered: string, before: string): void {
  if (rendered === before) return;
  if (before) writeFileSync(ENV_BACKUP_FILE, before, { mode: 0o600 });
  writeFileSync(ENV_TMP_FILE, rendered, { mode: 0o600 });
  renameSync(ENV_TMP_FILE, ENV_FILE);
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
  /**
   * Set when this run would regenerate a secret that a surviving data volume was created
   * with — a real run REFUSES in that state (see secretRotationRisk), so the preview has
   * to name it rather than describe writes that won't happen.
   */
  secretRotation: { volume: string; keys: string[] } | null;
  /**
   * Set when a surviving data volume holds data we can't place (#487) — a real run
   * REFUSES rather than write a guessed OPENSHIP_PGDATA, so the preview names it too.
   */
  pgDataRisk: { volume: string } | null;
  /** True when a `.env` is already there — this would be a re-run, not a fresh install. */
  existing: boolean;
  /** Host directories the edge's bind mounts need (created on a real run). */
  mountDirs: string[];
  /** From-source checkout the images would be BUILT from (null = pull published). */
  buildDir: string | null;
  /** The container→host SSH channel this run would provision, if any. */
  hostChannel: HostChannelTarget | null;
}

export function composePlan(opts: ComposeUpOpts): ComposePlan {
  const prev = readEnvFile();
  const cfg = resolveEnvConfig(prev, opts);
  const buildDir = opts.build === false ? null : sourceBuildDir();
  const hostChannel = previewHostChannel(cfg);
  const settings: Array<{ key: string; value: string }> = [];
  const newSecrets: string[] = [];
  for (const line of renderEnv(opts, hostChannel, cfg).split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || line.startsWith("#")) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (!SECRET_ENV_KEY.test(key)) {
      settings.push({ key, value });
      continue;
    }
    // Say WHICH secrets are preserved, never the value — and derive it from the bytes
    // this run would actually WRITE, not from a second guess at what keepSecret does
    // with them. #488 was reported as a dry run claiming preservation for a password it
    // then replaced; a label that can only say "<preserved>" when the rendered value IS
    // the one already on disk cannot make that claim wrongly.
    const preserved = !!prev[key] && prev[key] === value;
    if (!preserved) newSecrets.push(key);
    settings.push({ key, value: preserved ? "<preserved>" : "<generated on this run>" });
  }
  return {
    composeFile: COMPOSE_FILE,
    envFile: ENV_FILE,
    installMethodFile: INSTALL_METHOD_FILE,
    ...(buildDir ? { buildFile: BUILD_FILE } : {}),
    yaml: COMPOSE_YAML,
    settings,
    newSecrets,
    secretRotation: opts.resetSecrets ? null : secretRotationRisk(prev),
    pgDataRisk: pgDataDetectionRisk(prev),
    existing: Object.keys(prev).length > 0,
    mountDirs: composeEdgeMounts().map((m) => m.host),
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
 * Registry existence for the three images we PULL, probed BEFORE the pull so a tag
 * that isn't published yet fails with the images NAMED and a way forward, instead of
 * docker's opaque `manifest unknown` (#486). `docker manifest inspect` is a read-only
 * lookup against the registry — no layers pulled, no auth for public GHCR.
 *
 * Returns the refs the registry positively does NOT have. Returns null when the probe
 * can't be trusted — `manifest inspect` unavailable (experimental CLI disabled), or a
 * transient auth / network / TLS error — because a false "missing" must never block an
 * install: the pull stays the real gate, this only makes a known-missing tag legible.
 */
export function missingPinnedImages(registry: string, version: string): string[] | null {
  const missing: string[] = [];
  for (const { service } of BUILT_SERVICES) {
    const ref = `${registry}/openship-${service}:${version}`;
    const r = spawnSync("docker", ["manifest", "inspect", ref], { encoding: "utf8" });
    if (r.status === 0) continue;
    const stderr = `${r.stderr ?? ""}`.toLowerCase();
    // A definitive "the registry has no such manifest". Anything else (command not
    // found, unauthorized, timed out) is inconclusive → abandon the probe, never guess.
    if (/manifest unknown|no such manifest|manifest for .+ not found/.test(stderr)) {
      missing.push(ref);
      continue;
    }
    return null;
  }
  return missing;
}

/**
 * Abort — legibly — when the pinned tag isn't in the registry yet (#486), so a caller
 * can stop BEFORE touching the box. A no-op for a from-source install (it builds
 * api/dashboard/edge and pulls none of ours) and when the probe is inconclusive.
 * Returns true to proceed; false once it has printed why not.
 */
export function pinnedImagesReady(opts: ComposeUpOpts): boolean {
  if (sourceBuildDir()) return true;
  const prev = readEnvFile();
  const version = resolveImageVersion(opts);
  const missing = missingPinnedImages(resolveEnvConfig(prev, opts).registry, version);
  if (!missing || missing.length === 0) return true;

  const prevVersion = prev.OPENSHIP_VERSION?.trim();
  const out = [
    "",
    `  The pinned image tag \`${version}\` isn't in the registry yet:`,
    ...missing.map((ref) => `    ${ref}`),
    "",
    "  The CLI reached npm before its container images finished publishing — a",
    "  release-ordering race (#486). Nothing on this box was changed.",
    "",
    "  Any one of these gets you moving:",
    "    • Wait a few minutes and re-run — the images usually land right after a release.",
    "    • Pin a tag that exists:",
    "        openship up --compose --image-version <tag>",
    "        OPENSHIP_VERSION=<tag> openship up --compose",
  ];
  if (prevVersion && prevVersion !== version) {
    out.push(`    • Your current install runs \`${prevVersion}\`, a tag known good on this box.`);
  }
  out.push("");
  console.error(out.join("\n"));
  return false;
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
export interface ComposePrefetchResult {
  /** Images are on the box (or built). Nothing on :80/:443 has been touched either way. */
  ok: boolean;
  /**
   * The `.env` this run rendered differs from the one the RUNNING containers were
   * created with — so they need recreating, not a plain `up -d`.
   *
   * Owned here rather than by `composeUp` because one run materializes TWICE: this
   * prefetch has to write `.env` before `docker compose pull` can interpolate the
   * registry and tag out of it, and then `composeUp` renders again. By then the file on
   * disk IS this write, so `composeUp`'s own comparison always read "unchanged" and the
   * env-consuming services were never recreated — `.env` showed the fix while the
   * containers kept the environment they were created with. That is what made #509's
   * remedy hollow: `openship up` provisioned the host channel into `.env` and left the
   * api container running without OPENSHIP_HOST_SSH_HOST, so the very next deploy failed
   * with the same error the operator had just run `up` to fix.
   */
  envChanged: boolean;
}
export function composePrefetch(opts: ComposeUpOpts): ComposePrefetchResult {
  // materialize replaces `.env`, so the #488 gate has to be here too — the callers check
  // first and exit with a proper explanation, and this is the backstop for a new one that
  // forgets. See composeSecretRotationRisk.
  const rotation = composeSecretRotationRisk(opts);
  if (rotation) {
    console.error(renderSecretRotationRefusal(rotation));
    return { ok: false, envChanged: false };
  }
  const { buildDir, envChanged } = materialize(opts);
  if (buildDir) {
    // From-source: the BUILD is the slow part, so it belongs on this side of the
    // cutover too. Only the upstream images can be pulled for it.
    return {
      ok:
        compose(["pull", "postgres", "redis"], { withBuildOverride: true }) === 0 &&
        compose(["build"], { withBuildOverride: true }) === 0,
      envChanged,
    };
  }
  return { ok: compose(["pull"]) === 0, envChanged };
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
  for (const { host } of composeEdgeMounts()) {
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
): Promise<{ ok: boolean; apiPort: string; dashPort: string; refused?: boolean }> {
  // #486 gate for callers that DON'T prefetch (openship update → composeUpdate). The
  // prefetch path already checked and set alreadyFetched, so it's skipped there. Runs
  // before materialize: a tag the registry lacks must fail without writing files.
  if (!opts.alreadyFetched && !pinnedImagesReady(opts)) {
    const pre = resolveEnvConfig(readEnvFile(), opts);
    return { ok: false, apiPort: pre.apiPort, dashPort: pre.dashPort };
  }
  // #488: this install's `.env` no longer yields secrets a surviving data volume was
  // created with. Stop BEFORE materialize — it replaces `.env`, and once it has, the real
  // values are gone and the failure that follows (an api that can't authenticate) points
  // at nothing. Everything below assumes `.env` is either trustworthy or a first install.
  const rotation = composeSecretRotationRisk(opts);
  if (rotation) {
    const pre = resolveEnvConfig(readEnvFile(), opts);
    console.error(renderSecretRotationRefusal(rotation));
    // `refused` separates "this can't work" from "this didn't work": callers must not
    // offer a retry, because nothing about re-running changes the answer.
    return { ok: false, refused: true, apiPort: pre.apiPort, dashPort: pre.dashPort };
  }
  // #487: an existing data volume holds data we can't place. resolvePgData would fall back
  // to the subdir, but if the cluster is elsewhere that still orphans it — so refuse and let
  // the operator pin OPENSHIP_PGDATA rather than write a guess. Same "stop before materialize"
  // reasoning as the rotation gate: once `.env` is rewritten the safe recovery is harder.
  const pgData = composePgDataRisk(opts);
  if (pgData) {
    const pre = resolveEnvConfig(readEnvFile(), opts);
    console.error(renderPgDataRefusal(pgData));
    return { ok: false, refused: true, apiPort: pre.apiPort, dashPort: pre.dashPort };
  }
  const { buildDir, cfg, envChanged: rendered } = materialize(opts);
  // The EFFECTIVE ports, not the flags: a re-run with no flags keeps the ports the
  // install was configured with, so the summary must report those.
  const apiPort = cfg.apiPort;
  const dashPort = cfg.dashPort;
  // `env_file:` contents are read when a container is CREATED, so a changed .env
  // reaches the api/dashboard/edge only if they're recreated. Without this, an
  // env fix "succeeds" and changes nothing.
  //
  // A caller that already materialized this run (composePrefetch) owns the answer: our
  // own `rendered` compared `.env` against the prefetch's write and so always said
  // "unchanged". See ComposePrefetchResult.envChanged.
  const envChanged = opts.envChanged ?? rendered;
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
export async function composeUpdate(
  version?: string,
): Promise<{ applied: boolean; refused: boolean }> {
  if (!existsSync(COMPOSE_FILE)) return { applied: false, refused: false };
  const r = await composeUp(version ? { version } : {});
  return { applied: r.ok, refused: !!r.refused };
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
 * internal-token-gated endpoints.
 *
 * For "the token the API on this box is running with" — i.e. anything that isn't
 * specifically provisioning a compose stack it just brought up — use
 * `resolveInternalToken()` (lib/internal-token) instead. Choosing a store by hand is
 * the mistake that made reset-admin-password 401 on every compose install.
 */
export function composeInternalToken(): string | null {
  return readEnvFile().INTERNAL_TOKEN ?? null;
}

export const composePaths = {
  dir: COMPOSE_DIR,
  file: COMPOSE_FILE,
  env: ENV_FILE,
  envBackup: ENV_BACKUP_FILE,
};
