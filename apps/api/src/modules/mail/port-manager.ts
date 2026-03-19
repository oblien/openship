/**
 * Port conflict detection and resolution for mail server setup.
 *
 * Checks ports 80/443 before iRedMail installation, identifies what is
 * using them (Traefik, known services, unknown processes), and provides
 * resolution strategies:
 *
 *  - Traefik → migrate to internal ports + configure nginx gateway
 *  - Known services → stop/move managed services
 *  - Unknown → kill with user confirmation
 */

import type { CommandExecutor } from "@repo/adapters";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PortUsage {
  port: number;
  pid: number;
  process: string;
  command: string;
  isDocker: boolean;
  containerName?: string;
}

export interface PortConflict {
  port: number;
  usage: PortUsage;
  type: "traefik" | "known" | "unknown";
  serviceName?: string;
  resolutions: PortResolution[];
}

export interface PortResolution {
  id: string;
  label: string;
  description: string;
  destructive: boolean;
}

export type PortStepLogger = (
  stepId: number,
  level: "info" | "warn" | "error",
  message: string,
) => void;

// ─── Internal ports for Traefik after migration ──────────────────────────────

export const TRAEFIK_INTERNAL_HTTP = 8080;
export const TRAEFIK_INTERNAL_HTTPS = 8443;

// ─── Known service patterns ─────────────────────────────────────────────────

const KNOWN_SERVICES: Record<string, { label: string }> = {
  traefik: { label: "Traefik" },
  apache2: { label: "Apache" },
  httpd: { label: "Apache (httpd)" },
  caddy: { label: "Caddy" },
  haproxy: { label: "HAProxy" },
  lighttpd: { label: "Lighttpd" },
  nginx: { label: "Nginx" },
};

// ─── Detection helpers ───────────────────────────────────────────────────────

/**
 * Parse `ss -tlnp` output to extract what is listening on a given port.
 *
 * Typical line:
 *   LISTEN 0 4096 *:80 *:* users:(("traefik",pid=1234,fd=7))
 */
function parseSsOutput(output: string, targetPort: number): PortUsage | null {
  for (const line of output.split("\n")) {
    // Match *:PORT or 0.0.0.0:PORT or :::PORT
    if (!new RegExp(`[*:\\]]?:${targetPort}\\s`).test(line)) continue;

    const usersMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (!usersMatch) continue;

    return {
      port: targetPort,
      pid: parseInt(usersMatch[2], 10),
      process: usersMatch[1],
      command: "",
      isDocker: false,
    };
  }
  return null;
}

async function enrichUsage(
  exec: CommandExecutor,
  usage: PortUsage,
): Promise<void> {
  // Full command line
  try {
    usage.command = (
      await exec.exec(
        `cat /proc/${usage.pid}/cmdline 2>/dev/null | tr '\\0' ' '`,
      )
    ).trim();
  } catch {
    usage.command = "";
  }

  // Docker check via cgroup
  try {
    const cgroup = await exec.exec(
      `cat /proc/${usage.pid}/cgroup 2>/dev/null || echo ""`,
    );
    if (cgroup.includes("docker") || cgroup.includes("containerd")) {
      usage.isDocker = true;
      try {
        const idMatch = cgroup.match(
          /(?:docker-|\/docker\/)([a-f0-9]{12,})/,
        );
        if (idMatch) {
          const name = (
            await exec.exec(
              `docker inspect --format '{{.Name}}' ${idMatch[1]} 2>/dev/null || echo ""`,
            )
          )
            .trim()
            .replace(/^\//, "");
          if (name) usage.containerName = name;
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* /proc may not be readable */
  }
}

function classifyUsage(usage: PortUsage): PortConflict["type"] {
  const name = usage.process.toLowerCase();
  const container = (usage.containerName ?? "").toLowerCase();
  const cmd = usage.command.toLowerCase();

  if (
    name === "traefik" ||
    container.includes("traefik") ||
    cmd.includes("traefik")
  ) {
    return "traefik";
  }

  for (const key of Object.keys(KNOWN_SERVICES)) {
    if (name === key || container.includes(key) || cmd.includes(key)) {
      return "known";
    }
  }

  return "unknown";
}

function getServiceLabel(usage: PortUsage): string | undefined {
  const name = usage.process.toLowerCase();
  const container = (usage.containerName ?? "").toLowerCase();
  for (const [key, info] of Object.entries(KNOWN_SERVICES)) {
    if (name === key || container.includes(key)) return info.label;
  }
  return undefined;
}

function buildResolutions(conflict: PortConflict): PortResolution[] {
  switch (conflict.type) {
    case "traefik":
      return [
        {
          id: "migrate_traefik",
          label: "Integrate with Nginx",
          description:
            "Move Traefik to internal ports and route non-mail traffic through Nginx. Your deployed apps will keep working.",
          destructive: false,
        },
        {
          id: "stop_traefik",
          label: "Stop Traefik",
          description:
            "Stop Traefik entirely. Deployed apps will lose their reverse proxy until you restart it.",
          destructive: true,
        },
      ];

    case "known":
      return [
        {
          id: "stop_service",
          label: `Stop ${conflict.serviceName ?? conflict.usage.process}`,
          description: `Stop the ${conflict.serviceName ?? conflict.usage.process} service. It may need reconfiguration after mail setup.`,
          destructive: true,
        },
      ];

    default:
      return [
        {
          id: "kill_process",
          label: "Kill Process",
          description: `Kill process "${conflict.usage.process}" (PID ${conflict.usage.pid}). Make sure this process is not needed before proceeding.`,
          destructive: true,
        },
      ];
  }
}

// ─── Public: detection ───────────────────────────────────────────────────────

/**
 * Scan ports 80 and 443 for anything that would conflict with nginx /
 * the iRedMail installer.
 */
export async function detectPortConflicts(
  exec: CommandExecutor,
  log?: PortStepLogger,
  stepId = 3,
): Promise<PortConflict[]> {
  const conflicts: PortConflict[] = [];

  log?.(stepId, "info", "Checking ports 80 and 443...");

  let ssOutput: string;
  try {
    ssOutput = await exec.exec(
      "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ''",
    );
  } catch {
    log?.(stepId, "warn", "Could not run ss or netstat — skipping port check");
    return [];
  }

  // De-duplicate by PID (same process may hold both ports)
  const seen = new Set<number>();

  for (const port of [80, 443] as const) {
    const usage = parseSsOutput(ssOutput, port);
    if (!usage) {
      log?.(stepId, "info", `Port ${port} is free`);
      continue;
    }

    // Enrich with Docker info + full cmdline
    if (!seen.has(usage.pid)) {
      await enrichUsage(exec, usage);
      seen.add(usage.pid);
    }

    const type = classifyUsage(usage);
    const serviceName =
      type === "traefik" ? "Traefik" : getServiceLabel(usage);

    const conflict: PortConflict = {
      port,
      usage,
      type,
      serviceName,
      resolutions: [],
    };
    conflict.resolutions = buildResolutions(conflict);

    log?.(
      stepId,
      type === "unknown" ? "warn" : "info",
      `Port ${port}: ${usage.process} (PID ${usage.pid})${usage.containerName ? ` [container: ${usage.containerName}]` : ""} — ${type}`,
    );

    conflicts.push(conflict);
  }

  return conflicts;
}

// ─── Public: resolution ──────────────────────────────────────────────────────

/**
 * Resolve a single port conflict by applying the chosen resolution.
 */
export async function resolveConflict(
  exec: CommandExecutor,
  conflict: PortConflict,
  resolutionId: string,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  const resolution = conflict.resolutions.find((r) => r.id === resolutionId);
  if (!resolution) {
    return { success: false, message: `Unknown resolution: ${resolutionId}` };
  }

  log?.(stepId, "info", `Applying: ${resolution.label}...`);

  switch (resolutionId) {
    case "migrate_traefik":
      return migrateTraefik(exec, log, stepId);
    case "stop_traefik":
      return stopTraefik(exec, log, stepId);
    case "stop_service":
      return stopService(exec, conflict.usage, log, stepId);
    case "kill_process":
      return killProcess(exec, conflict.usage, log, stepId);
    default:
      return { success: false, message: `Unhandled resolution: ${resolutionId}` };
  }
}

// ─── Traefik migration (Phase 1) ────────────────────────────────────────────

async function migrateTraefik(
  exec: CommandExecutor,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  log?.(stepId, "info", "Migrating Traefik to internal ports...");

  const isDocker = await isDockerTraefik(exec);
  return isDocker
    ? migrateDockerTraefik(exec, log, stepId)
    : migrateBinaryTraefik(exec, log, stepId);
}

async function isDockerTraefik(exec: CommandExecutor): Promise<boolean> {
  try {
    const out = await exec.exec(
      "docker ps --filter name=traefik --format '{{.Names}}' 2>/dev/null || echo ''",
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

async function migrateDockerTraefik(
  exec: CommandExecutor,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  try {
    log?.(stepId, "info", "Stopping Traefik container...");
    const acmeEmail = await getTraefikAcmeEmail(exec);

    await exec.exec("docker stop traefik 2>/dev/null || true");
    await exec.exec("docker rm traefik 2>/dev/null || true");
    await exec.exec("mkdir -p /etc/traefik/dynamic /etc/traefik/acme");

    const runCmd = [
      "docker run -d",
      "--name traefik",
      "--restart unless-stopped",
      "--network host",
      "-v /var/run/docker.sock:/var/run/docker.sock:ro",
      "-v /etc/traefik:/etc/traefik",
      "traefik:v3.4",
      "--providers.file.directory=/etc/traefik/dynamic",
      "--providers.file.watch=true",
      `--entrypoints.web.address=:${TRAEFIK_INTERNAL_HTTP}`,
      `--entrypoints.websecure.address=:${TRAEFIK_INTERNAL_HTTPS}`,
      `--certificatesresolvers.letsencrypt.acme.email=${acmeEmail}`,
      "--certificatesresolvers.letsencrypt.acme.storage=/etc/traefik/acme/acme.json",
      "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
    ];

    log?.(
      stepId,
      "info",
      `Starting Traefik on ports ${TRAEFIK_INTERNAL_HTTP}/${TRAEFIK_INTERNAL_HTTPS}...`,
    );
    await exec.exec(runCmd.join(" "));
    await sleep(2000);

    const check = await exec.exec(
      "docker ps --filter name=traefik --format '{{.Status}}' 2>/dev/null || echo 'not running'",
    );

    if (!check.includes("Up")) {
      return {
        success: false,
        message: "Traefik container failed to start on new ports",
      };
    }

    await writeMigrationState(exec);
    log?.(stepId, "info", "Traefik restarted on internal ports");
    return {
      success: true,
      message: `Traefik migrated to ports ${TRAEFIK_INTERNAL_HTTP}/${TRAEFIK_INTERNAL_HTTPS}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(stepId, "error", `Traefik migration failed: ${msg}`);
    return { success: false, message: `Traefik migration failed: ${msg}` };
  }
}

async function migrateBinaryTraefik(
  exec: CommandExecutor,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  try {
    log?.(stepId, "info", "Stopping Traefik process...");
    await exec.exec("systemctl stop traefik 2>/dev/null || pkill traefik 2>/dev/null || true");
    await sleep(1000);

    // Update static config if exists
    const configPath = (
      await exec.exec(
        "[ -f /etc/traefik/traefik.yml ] && echo /etc/traefik/traefik.yml || ([ -f /etc/traefik/traefik.yaml ] && echo /etc/traefik/traefik.yaml || echo '')",
      )
    ).trim();

    if (configPath) {
      log?.(stepId, "info", `Updating ${configPath}...`);
      await exec.exec(`cp ${configPath} ${configPath}.bak.openship`);
      await exec.exec(
        `sed -i 's/:80$/:${TRAEFIK_INTERNAL_HTTP}/' ${configPath}`,
      );
      await exec.exec(
        `sed -i 's/:443$/:${TRAEFIK_INTERNAL_HTTPS}/' ${configPath}`,
      );
    }

    // Try to restart via systemd
    const hasUnit = await exec.exec(
      "systemctl list-unit-files traefik.service 2>/dev/null | grep -c traefik || echo 0",
    );

    if (parseInt(hasUnit.trim(), 10) > 0) {
      await exec.exec("systemctl restart traefik");
    } else {
      log?.(
        stepId,
        "warn",
        "No systemd service for Traefik — process stopped. You may need to restart Traefik manually.",
      );
    }

    await writeMigrationState(exec);
    return {
      success: true,
      message: `Traefik migrated to ports ${TRAEFIK_INTERNAL_HTTP}/${TRAEFIK_INTERNAL_HTTPS}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(stepId, "error", `Traefik migration failed: ${msg}`);
    return { success: false, message: `Traefik migration failed: ${msg}` };
  }
}

async function getTraefikAcmeEmail(exec: CommandExecutor): Promise<string> {
  try {
    const cmd = await exec.exec(
      "docker inspect traefik --format '{{json .Config.Cmd}}' 2>/dev/null || echo '[]'",
    );
    const m = cmd.match(/acme\.email=([^\s"]+)/);
    if (m) return m[1];

    const cfg = await exec.exec(
      "cat /etc/traefik/traefik.yml 2>/dev/null || cat /etc/traefik/traefik.yaml 2>/dev/null || echo ''",
    );
    const ymlMatch = cfg.match(/email:\s*(\S+)/);
    if (ymlMatch) return ymlMatch[1];
  } catch {
    /* fall through */
  }
  return "admin@localhost";
}

async function stopTraefik(
  exec: CommandExecutor,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  log?.(stepId, "info", "Stopping Traefik...");
  try {
    await exec.exec("docker stop traefik 2>/dev/null || true");
    await exec.exec(
      "systemctl stop traefik 2>/dev/null || pkill traefik 2>/dev/null || true",
    );
    await sleep(1000);
    log?.(stepId, "info", "Traefik stopped");
    return { success: true, message: "Traefik stopped" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to stop Traefik: ${msg}` };
  }
}

// ─── Service / process management ────────────────────────────────────────────

async function stopService(
  exec: CommandExecutor,
  usage: PortUsage,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  const label = usage.containerName ?? usage.process;
  try {
    if (usage.isDocker && usage.containerName) {
      log?.(stepId, "info", `Stopping container: ${usage.containerName}...`);
      await exec.exec(`docker stop ${usage.containerName}`);
    } else {
      log?.(stepId, "info", `Stopping service: ${usage.process}...`);
      const stopped = await exec.exec(
        `systemctl stop ${usage.process} 2>/dev/null && echo OK || echo FAIL`,
      );
      if (stopped.includes("FAIL")) {
        await exec.exec(`kill ${usage.pid}`);
      }
    }
    await sleep(1000);
    log?.(stepId, "info", `${label} stopped`);
    return { success: true, message: `${label} stopped` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to stop ${label}: ${msg}` };
  }
}

async function killProcess(
  exec: CommandExecutor,
  usage: PortUsage,
  log?: PortStepLogger,
  stepId = 3,
): Promise<{ success: boolean; message: string }> {
  log?.(stepId, "warn", `Killing ${usage.process} (PID ${usage.pid})...`);
  try {
    if (usage.isDocker && usage.containerName) {
      await exec.exec(`docker stop ${usage.containerName}`);
    } else {
      await exec.exec(`kill ${usage.pid}`);
      await sleep(500);
      await exec.exec(`kill -9 ${usage.pid} 2>/dev/null || true`);
    }
    await sleep(1000);
    return {
      success: true,
      message: `Process ${usage.process} (PID ${usage.pid}) killed`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to kill process: ${msg}` };
  }
}

// ─── Migration state ─────────────────────────────────────────────────────────

const MIGRATION_STATE_PATH = "/etc/traefik/.openship-migration.json";

async function writeMigrationState(exec: CommandExecutor): Promise<void> {
  const state = JSON.stringify({
    migrated: true,
    httpPort: TRAEFIK_INTERNAL_HTTP,
    httpsPort: TRAEFIK_INTERNAL_HTTPS,
    migratedAt: new Date().toISOString(),
  });
  await exec.exec(`mkdir -p /etc/traefik`);
  await exec.writeFile(MIGRATION_STATE_PATH, state);
}

/**
 * Check if Traefik was migrated during this setup (used by the post-install
 * reverse proxy step).
 */
export async function wasTraefikMigrated(
  exec: CommandExecutor,
): Promise<boolean> {
  try {
    const out = await exec.exec(
      `cat ${MIGRATION_STATE_PATH} 2>/dev/null || echo ''`,
    );
    if (!out.trim()) return false;
    return JSON.parse(out.trim()).migrated === true;
  } catch {
    return false;
  }
}

// ─── Nginx gateway (Phase 2 — after iRedMail install + reboot) ──────────────

/**
 * Configure nginx as a gateway that forwards non-mail traffic to Traefik.
 *
 * HTTP: catch-all server block → proxy to Traefik:8080
 * HTTPS: if the stream module is available, use SNI-based routing so that
 *   mail.domain → nginx's own SSL handler
 *   everything else → Traefik:8443 (raw TCP passthrough, Traefik keeps its
 *   own ACME certs)
 */
export async function setupNginxGateway(
  exec: CommandExecutor,
  mailDomain: string,
  log?: PortStepLogger,
  stepId = 10,
): Promise<{ success: boolean; message: string }> {
  log?.(stepId, "info", "Configuring nginx gateway for Traefik integration...");

  try {
    // Check if stream module is available
    const hasStream = (
      await exec.exec("nginx -V 2>&1 | grep -o 'with-stream' || echo MISSING")
    ).includes("with-stream");

    // ── HTTP catch-all ────────────────────────────────────────────

    const httpConf = `# Openship: forward non-mail HTTP traffic to Traefik
# Auto-generated — do not edit manually
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:${TRAEFIK_INTERNAL_HTTP};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
`;

    log?.(stepId, "info", "Writing HTTP gateway config...");

    // iRedMail may use sites-enabled or conf.d — handle both
    const sitesDir = (
      await exec.exec(
        "[ -d /etc/nginx/sites-available ] && echo sites || echo conf",
      )
    ).trim();

    if (sitesDir === "sites") {
      await exec.writeFile(
        "/etc/nginx/sites-available/00-traefik-gateway.conf",
        httpConf,
      );
      await exec.exec(
        "ln -sf /etc/nginx/sites-available/00-traefik-gateway.conf /etc/nginx/sites-enabled/00-traefik-gateway.conf",
      );
    } else {
      await exec.writeFile(
        "/etc/nginx/conf.d/00-traefik-gateway.conf",
        httpConf,
      );
    }

    // Remove default site if it conflicts
    await exec.exec("rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true");

    // ── HTTPS SNI routing (optional, requires stream module) ─────

    if (hasStream) {
      log?.(
        stepId,
        "info",
        "Stream module available — configuring HTTPS SNI routing...",
      );

      // Move iRedMail's SSL listen to an internal port so stream block
      // can own :443 and route by SNI.
      const NGINX_SSL_INTERNAL = 4443;

      await exec.exec(
        `find /etc/nginx -name '*.conf' -exec grep -l 'listen.*443.*ssl' {} \\; 2>/dev/null | while read f; do ` +
          `cp "$f" "$f.bak.openship" && ` +
          `sed -i 's/listen 443 ssl/listen ${NGINX_SSL_INTERNAL} ssl/' "$f" && ` +
          `sed -i 's/listen \\[::]:443 ssl/listen [::]:${NGINX_SSL_INTERNAL} ssl/' "$f"; ` +
          `done`,
      );

      const streamConf = `# Openship: HTTPS SNI routing
# Auto-generated — do not edit manually
stream {
    map $ssl_preread_server_name $https_backend {
        ${mailDomain}    127.0.0.1:${NGINX_SSL_INTERNAL};
        default          127.0.0.1:${TRAEFIK_INTERNAL_HTTPS};
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass $https_backend;
    }
}
`;

      await exec.exec("mkdir -p /etc/nginx/stream.d");
      await exec.writeFile(
        "/etc/nginx/stream.d/ssl-sni-routing.conf",
        streamConf,
      );

      // Make sure nginx.conf includes the stream directory
      const nginxConf = await exec.exec("cat /etc/nginx/nginx.conf");
      if (!nginxConf.includes("stream.d")) {
        log?.(stepId, "info", "Adding stream include to nginx.conf...");
        // Append at the very end (outside any existing block)
        await exec.exec(
          `echo '\\ninclude /etc/nginx/stream.d/*.conf;' >> /etc/nginx/nginx.conf`,
        );
      }
    } else {
      log?.(
        stepId,
        "warn",
        "Nginx stream module not available — HTTPS SNI routing skipped. Non-mail HTTPS domains will need manual nginx configuration.",
      );
    }

    // ── Validate + reload ────────────────────────────────────────

    log?.(stepId, "info", "Testing nginx configuration...");
    const testResult = await exec.exec("nginx -t 2>&1 || echo NGINX_TEST_FAILED");

    if (
      testResult.includes("NGINX_TEST_FAILED") ||
      testResult.includes("emerg")
    ) {
      log?.(stepId, "error", `Nginx config test failed:\n${testResult}`);
      return {
        success: false,
        message: "Nginx configuration test failed after gateway setup",
      };
    }

    log?.(stepId, "info", "Reloading nginx...");
    await exec.exec("systemctl reload nginx 2>/dev/null || nginx -s reload");

    // Make sure Traefik is actually running
    const traefikUp = (
      await exec.exec(
        "docker ps --filter name=traefik --format '{{.Names}}' 2>/dev/null || pgrep -x traefik 2>/dev/null || echo ''",
      )
    ).trim();

    if (!traefikUp) {
      log?.(stepId, "warn", "Traefik not running — attempting to start...");
      await exec.exec(
        "docker start traefik 2>/dev/null || systemctl start traefik 2>/dev/null || true",
      );
    }

    log?.(stepId, "info", "Nginx gateway configured — Traefik integration complete");
    return {
      success: true,
      message: "Nginx gateway configured for Traefik integration",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(stepId, "error", `Nginx gateway setup failed: ${msg}`);
    return { success: false, message: `Nginx gateway setup failed: ${msg}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
