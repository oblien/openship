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

declare const __CLI_VERSION__: string;

const OS_DIR = join(homedir(), ".openship");
const COMPOSE_DIR = join(OS_DIR, "compose");
const INSTALL_METHOD_FILE = join(OS_DIR, "install-method");
const COMPOSE_FILE = join(COMPOSE_DIR, "docker-compose.yml");
const ENV_FILE = join(COMPOSE_DIR, ".env");

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

export interface ComposeUpOpts {
  apiPort?: string;
  dashboardPort?: string;
  publicUrl?: string;
  trustProxy?: boolean;
  registry?: string;
  version?: string;
}

/** Pinned compose stack. Vars come from the generated .env (env_file + interpolation). */
const COMPOSE_YAML = `# Managed by \`openship up\` — do not edit; re-run \`openship up\` to regenerate.
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-openship}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-openship}
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
      # Host-op SSH key (createHostExecutor → host.docker.internal). /dev/null
      # when the host channel isn't provisioned → OPENSHIP_HOST_SSH_HOST stays
      # unset and the API falls back to LocalExecutor.
      - \${OPENSHIP_HOST_KEY_PATH:-/dev/null}:/run/secrets/openship_host_key:ro
    extra_hosts: ["host.docker.internal:host-gateway"]
    env_file: [.env]
    environment:
      NODE_ENV: production
      PORT: "\${API_PORT:-4000}"
      DATABASE_URL: postgresql://\${POSTGRES_USER:-openship}:\${POSTGRES_PASSWORD:-openship}@postgres:5432/\${POSTGRES_DB:-openship}
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
    restart: unless-stopped
    network_mode: host
    volumes:
      - openship_sites:/usr/local/openresty/nginx/conf/sites-enabled
      - openship_certs:/etc/letsencrypt
      - openship_acme:/var/www/acme

volumes:
  postgres_data:
  redis_data:
  openship_sites:
  openship_certs:
  openship_acme:
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

function renderEnv(opts: ComposeUpOpts, host: { user: string; keyPath: string } | null): string {
  const prev = readEnvFile();
  const lines: string[] = [
    "# Managed by `openship up`. Secrets are generated once and preserved.",
    "CLOUD_MODE=false",
    "OPENSHIP_TARGET=local",
    "OPENSHIP_REQUIRE_AUTH=true",
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

function materialize(opts: ComposeUpOpts): void {
  mkdirSync(COMPOSE_DIR, { recursive: true, mode: 0o700 });
  const host = provisionHostSshChannel(); // best-effort; null → LocalExecutor fallback
  writeFileSync(COMPOSE_FILE, COMPOSE_YAML);
  writeFileSync(ENV_FILE, renderEnv(opts, host), { mode: 0o600 });
}

/** Run `docker compose <args>` in the compose dir, inheriting stdio. */
function compose(args: string[], opts?: { quiet?: boolean }): number {
  const r = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: COMPOSE_DIR,
    stdio: opts?.quiet ? "ignore" : "inherit",
  });
  return r.status ?? 1;
}

/** `openship up` (compose): write files, pull the pinned images, start the stack. */
export function composeUp(opts: ComposeUpOpts): { ok: boolean; apiPort: string; dashPort: string } {
  materialize(opts);
  const apiPort = opts.apiPort || "4000";
  const dashPort = opts.dashboardPort || "3001";
  if (compose(["pull"]) !== 0) return { ok: false, apiPort, dashPort };
  if (compose(["up", "-d"]) !== 0) return { ok: false, apiPort, dashPort };
  writeInstallMethod("compose");
  return { ok: true, apiPort, dashPort };
}

export function composeDown(): boolean {
  if (!existsSync(COMPOSE_FILE)) return false;
  return compose(["down"]) === 0;
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
  return compose(["pull"]) === 0 && compose(["up", "-d"]) === 0;
}

export function composePs(): number {
  return compose(["ps"]);
}

export const composePaths = { dir: COMPOSE_DIR, file: COMPOSE_FILE, env: ENV_FILE };
