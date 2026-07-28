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
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { systemCatalog, type EnvironmentProfile } from "@repo/adapters";

import { OS_DIR } from "./paths";
import { readSourceInstall } from "./source-install";

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

/** docker + `docker compose` both present. */
export function hasDockerCompose(): boolean {
  const docker = spawnSync("docker", ["version"], { stdio: "ignore" });
  if (docker.status !== 0) return false;
  const compose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  return compose.status === 0;
}

/**
 * Compose is the default install method when it can actually work: docker +
 * compose present AND Linux (the `edge` container needs host networking, which
 * Docker Desktop on mac/win doesn't provide — those fall back to bare).
 */
export function composeIsViableDefault(): boolean {
  return process.platform === "linux" && hasDockerCompose();
}

/** `cmd` is on PATH (probes `cmd --version`). */
function hasCmd(cmd: string): boolean {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Single-quote a string for `sh -c`. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
 */
export async function ensureDocker(): Promise<boolean> {
  if (hasDockerCompose()) return true;
  if (process.platform !== "linux") return false;

  const plan = systemCatalog.installs.docker({
    os: "linux",
    serviceManager: "systemd",
  } as unknown as EnvironmentProfile);
  if (!plan.supported || !plan.installCommand) return false;

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const sudo = !asRoot && hasCmd("sudo") ? "sudo " : "";
  const sh = (script: string): number =>
    spawnSync("sh", ["-c", sudo ? `${sudo}sh -c ${shQuote(script)}` : script], {
      stdio: "inherit",
    }).status ?? 1;

  if (sh(plan.installCommand) !== 0) return false;
  // Best-effort daemon start (get.docker.com already enables it on systemd).
  if (plan.startCommand) sh(plan.startCommand);
  return hasDockerCompose();
}

export interface ComposeUpOpts {
  /** Don't give the api a channel to the HOST OS (no key, no mount, refuse ops). */
  noHostControl?: boolean;
  apiPort?: string;
  dashboardPort?: string;
  publicUrl?: string;
  trustProxy?: boolean;
  registry?: string;
  version?: string;
  /** Force the pull path even on a from-source install (escape hatch). */
  build?: boolean;
}

/** Pinned compose stack. Vars come from the generated .env (env_file + interpolation). */
const COMPOSE_YAML = `# Managed by \`openship up\` — do not edit; re-run \`openship up\` to regenerate.
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
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
    ports: ["\${OPENSHIP_BIND_ADDR:-0.0.0.0}:\${API_PORT:-4000}:\${API_PORT:-4000}"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - openship_sites:/usr/local/openresty/nginx/conf/sites-enabled
      - openship_certs:/etc/letsencrypt
      - openship_acme:/var/www/acme
      # Static sites' extracted doc-roots — API writes, edge serves (shared).
      - openship_static:/opt/openship/static
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
    ports: ["\${OPENSHIP_BIND_ADDR:-0.0.0.0}:\${DASHBOARD_PORT:-3001}:\${DASHBOARD_PORT:-3001}"]
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
      - openship_sites:/usr/local/openresty/nginx/conf/sites-enabled
      - openship_certs:/etc/letsencrypt
      - openship_acme:/var/www/acme
      - openship_static:/opt/openship/static

volumes:
  postgres_data:
  redis_data:
  openship_sites:
  openship_certs:
  openship_acme:
  openship_static:
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
function provisionHostSshChannel(): { user: string; keyPath: string } | null {
  if (process.platform !== "linux") return null; // host.docker.internal SSH is the Linux compose path
  try {
    const sshDir = join(COMPOSE_DIR, "host-ssh");
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const keyPath = join(sshDir, "id_ed25519");
    if (!existsSync(keyPath)) {
      const g = spawnSync(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-q", "-f", keyPath, "-C", "openship-host-executor"],
        { stdio: "ignore" },
      );
      if (g.status !== 0) return null;
    }
    const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
    if (!pub) return null;

    // Authorize the key for the host user running `openship up` (the container
    // SSHes in as this user). Idempotent — only append if not already present.
    const userSshDir = join(homedir(), ".ssh");
    mkdirSync(userSshDir, { recursive: true, mode: 0o700 });
    const authKeys = join(userSshDir, "authorized_keys");
    const existing = existsSync(authKeys) ? readFileSync(authKeys, "utf8") : "";
    if (!existing.includes(pub)) {
      const sep = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(authKeys, `${existing}${sep}${pub}\n`, { mode: 0o600 });
    }
    return { user: process.env.USER || process.env.LOGNAME || "root", keyPath };
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
  const r = spawnSync(
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
      user,
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
      input: `ALTER USER "${user}" WITH PASSWORD '${password}';\n`,
    },
  );
  if (r.status !== 0) {
    console.log(
      `  Note: couldn't reconcile the database password (${(r.stderr ?? "").trim() || "psql failed"}).\n` +
        `  If the api reports "password authentication failed", the data volume predates this install —\n` +
        `  either restore the old .env or remove the volume to start fresh.`,
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
 * Warn when a previous project's data volumes exist but won't be mounted, so a
 * project-name change can never look like silent data loss. Our compose declares
 * the volume key `openship_sites`, so any `<project>_openship_sites` names a prior
 * stack of ours.
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
      `  and are NOT mounted by this stack — its database and certificates start fresh.\n` +
      `  Remove them with \`docker volume ls | grep _openship_\` once you're sure they aren't needed.`,
  );
}

function renderEnv(opts: ComposeUpOpts, host: { user: string; keyPath: string } | null): string {
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
    `OPENSHIP_HOST_CONTROL=${opts.noHostControl ? "false" : "true"}`,
    `OPENSHIP_IMAGE_REGISTRY=${opts.registry || "ghcr.io/oblien"}`,
    `OPENSHIP_VERSION=${opts.version || (typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "latest")}`,
    `POSTGRES_PASSWORD=${keepSecret(prev, "POSTGRES_PASSWORD")}`,
    `BETTER_AUTH_SECRET=${keepSecret(prev, "BETTER_AUTH_SECRET")}`,
    `INTERNAL_TOKEN=${keepSecret(prev, "INTERNAL_TOKEN")}`,
  ];
  if (opts.apiPort) lines.push(`API_PORT=${opts.apiPort}`);
  if (opts.dashboardPort) lines.push(`DASHBOARD_PORT=${opts.dashboardPort}`);
  if (opts.publicUrl) lines.push(`OPENSHIP_PUBLIC_URL=${opts.publicUrl}`);
  if (opts.trustProxy || opts.publicUrl) lines.push("TRUST_PROXY=true");
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
  regeneratedSecrets: boolean;
} {
  mkdirSync(COMPOSE_DIR, { recursive: true, mode: 0o700 });
  // Read BEFORE the write: a missing POSTGRES_PASSWORD here means the one we're
  // about to write is brand new, which is the case that can mismatch a surviving
  // data volume (see reconcileDbPassword).
  const regeneratedSecrets = !readEnvFile().POSTGRES_PASSWORD;
  // --no-host-control: never generate/authorize a host key in the first place.
  // Not just "don't use it" — there is nothing on disk to steal.
  const host = opts.noHostControl ? null : provisionHostSshChannel();
  writeFileSync(COMPOSE_FILE, COMPOSE_YAML);
  writeFileSync(ENV_FILE, renderEnv(opts, host), { mode: 0o600 });

  const buildDir = opts.build === false ? null : sourceBuildDir();
  if (buildDir) writeFileSync(BUILD_FILE, renderBuildOverride(buildDir));
  return { buildDir, regeneratedSecrets };
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
 * `openship up` (compose): write files, then either PULL the pinned images
 * (normal install) or BUILD api/dashboard/edge from the source checkout (dev
 * install). Postgres/redis are upstream images and are pulled either way.
 */
export function composeUp(opts: ComposeUpOpts): { ok: boolean; apiPort: string; dashPort: string } {
  const { buildDir, regeneratedSecrets } = materialize(opts);
  const apiPort = opts.apiPort || "4000";
  const dashPort = opts.dashboardPort || "3001";

  // A previous stack under a different project name would still hold :80/:443
  // (host-networked edge) and 4000/3001, leaving the new edge in a bind() crash
  // loop while the old one serves stale vhosts. Clear it before bringing ours up.
  const env = readEnvFile();
  const project = env.COMPOSE_PROJECT_NAME || "openship";
  removeOrphanedStack(project);
  warnOrphanedVolumes(project);

  // Freshly minted secrets + a surviving data volume = the api will fail auth
  // against a password only the volume knows. Realign it before anything depends
  // on the db (see reconcileDbPassword).
  if (regeneratedSecrets && dbVolumeExists(project)) {
    console.log("  Existing database volume with regenerated credentials — realigning the password...");
    reconcileDbPassword(env.POSTGRES_USER || "openship", env.POSTGRES_PASSWORD ?? "");
  }

  if (buildDir) {
    // Only the upstream images can be pulled; ours don't exist in a registry for
    // this ref. `--pull=false` on build keeps it working offline after the first run.
    if (compose(["pull", "postgres", "redis"], { withBuildOverride: true }) !== 0) {
      return { ok: false, apiPort, dashPort };
    }
    if (compose(["build"], { withBuildOverride: true }) !== 0) {
      return { ok: false, apiPort, dashPort };
    }
    if (compose(["up", "-d"], { withBuildOverride: true }) !== 0) {
      return { ok: false, apiPort, dashPort };
    }
    writeInstallMethod("compose");
    return { ok: true, apiPort, dashPort };
  }

  if (compose(["pull"]) !== 0) return { ok: false, apiPort, dashPort };
  if (compose(["up", "-d"]) !== 0) return { ok: false, apiPort, dashPort };
  writeInstallMethod("compose");
  return { ok: true, apiPort, dashPort };
}

export function composeDown(): boolean {
  if (!existsSync(COMPOSE_FILE)) return false;
  return compose(["down"]) === 0;
}

/**
 * `openship uninstall` (compose): tear the stack down INCLUDING its volumes, and
 * optionally delete the images we own.
 *
 * `down -v` is the destructive part — those volumes hold the database, the issued
 * certificates and the edge's vhosts. Only ever called behind an explicit
 * confirmation. `--remove-orphans` also collects containers from an earlier
 * project name so an uninstall doesn't leave a stale edge holding :80/:443.
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
    const registry = env.OPENSHIP_IMAGE_REGISTRY || "ghcr.io/oblien";
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

/** `openship update` (compose): pull the latest pinned images + recreate. */
export function composeUpdate(version?: string): boolean {
  if (!existsSync(COMPOSE_FILE)) return false;
  // Repin the version if provided, else keep the .env's pin.
  if (version) {
    const env = readEnvFile();
    env.OPENSHIP_VERSION = version;
    writeFileSync(
      ENV_FILE,
      Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  // A from-source install rebuilds from its checkout — there is no published
  // image for the branch it tracks.
  if (sourceBuildDir()) {
    return (
      compose(["build"], { withBuildOverride: true }) === 0 &&
      compose(["up", "-d"], { withBuildOverride: true }) === 0
    );
  }
  return compose(["pull"]) === 0 && compose(["up", "-d"]) === 0;
}

export function composePs(): number {
  return compose(["ps"]);
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
