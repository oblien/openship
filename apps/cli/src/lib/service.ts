/**
 * OS service backend for `openship up` / `openship stop`.
 *
 * `openship up` (default) installs Openship as a persistent service that
 * auto-restarts on crash and starts on boot, running until `openship stop`.
 * The service runs `openship up --foreground` — the attached supervisor in
 * commands/up.ts — so the OS service manager is what keeps it alive.
 *
 *   - macOS   → launchd LaunchAgent (~/Library/LaunchAgents), KeepAlive + RunAtLoad
 *   - Linux   → systemd unit (system when root, else --user + linger), Restart=always
 *   - Windows → Scheduled Task at logon (best-effort; see docs)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();
const OS_DIR = join(HOME, ".openship");
const LOG_DIR = join(OS_DIR, "logs");

const MAC_LABEL = "io.openship.up";
const MAC_PLIST = join(HOME, "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const SYSTEMD_NAME = "openship";
const WIN_TASK = "Openship";

/** Flags the user gave to `openship up`, replayed into the service's run command. */
export interface UpFlags {
  port?: string;
  dataDir?: string;
  dashboardPort?: string;
  /** false → pass --no-ui */
  ui?: boolean;
  uiVersion?: string;
  /** Serve remotely at this public URL (enables proxy + login). */
  publicUrl?: string;
  /** Trust X-Forwarded-For from a front proxy. */
  trustProxy?: boolean;
  /** Bind the dashboard to this interface (reverse-proxy / LAN access). */
  host?: string;
  /** Managed edge: install OpenResty + Let's Encrypt on this box and route here. */
  managedEdge?: boolean;
  /** ACME contact email for the managed edge. */
  acmeEmail?: string;
}

/** The CLI's own runtime + entry, so the service invokes THIS install. */
function selfInvocation(): { runtime: string; args: string[] } {
  const runtime = process.execPath; // node or bun that's running us
  const entry = resolve(process.argv[1] ?? ""); // dist/index.js (absolute)
  return { runtime, args: [entry] };
}

function upArgs(flags: UpFlags): string[] {
  const a = ["up", "--foreground"];
  if (flags.port) a.push("--port", flags.port);
  if (flags.dataDir) a.push("--data-dir", flags.dataDir);
  if (flags.dashboardPort) a.push("--dashboard-port", flags.dashboardPort);
  if (flags.ui === false) a.push("--no-ui");
  if (flags.uiVersion) a.push("--ui-version", flags.uiVersion);
  if (flags.publicUrl) a.push("--public-url", flags.publicUrl);
  if (flags.trustProxy) a.push("--trust-proxy");
  if (flags.host) a.push("--host", flags.host);
  if (flags.managedEdge) a.push("--managed-edge");
  if (flags.acmeEmail) a.push("--acme-email", flags.acmeEmail);
  return a;
}

/** Full argv the service runs: [runtime, entry, "up", "--foreground", …flags]. */
function runArgv(flags: UpFlags): string[] {
  const { runtime, args } = selfInvocation();
  return [runtime, ...args, ...upArgs(flags)];
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Block synchronously for `ms` — restart()/serviceStatus() are sync and the
 *  wizard calls them sync, so we poll launchd without going async. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A launchd agent's LIVE pid, or null. `launchctl list <label>` prints a
 * plist-ish dict; the `"PID"` key is present ONLY while an instance is actually
 * running. A loaded-but-crashed/throttled agent has no PID (just a non-zero
 * `"LastExitStatus"`) — so this is the real "is it up?" check, unlike
 * `launchctl list`'s exit code (which is 0 whenever the label is merely loaded).
 */
function launchdPid(): number | null {
  const r = run("launchctl", ["list", MAC_LABEL]);
  if (!r.ok) return null;
  const m = r.out.match(/"PID"\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The agent's last exit status (from `launchctl list`), or null if unknown. */
function launchdLastExit(): number | null {
  const m = run("launchctl", ["list", MAC_LABEL]).out.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
  return m ? Number(m[1]) : null;
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export type ServiceKind = "launchd" | "systemd-user" | "systemd-system" | "schtasks" | "unsupported";

export function detectKind(): ServiceKind {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    if (!hasSystemd()) return "unsupported";
    return isRoot() ? "systemd-system" : "systemd-user";
  }
  if (process.platform === "win32") return "schtasks";
  return "unsupported";
}

function hasSystemd(): boolean {
  return spawnSync("sh", ["-c", "command -v systemctl"]).status === 0;
}

/* ── file builders ──────────────────────────────────────────────────────── */

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Extra env the service should carry. Only OPENSHIP_DASHBOARD_DIR today, and
 *  only when set — lets `openship`/wizard run a locally-built dashboard for
 *  pre-release testing; unset in production so nothing changes. */
function serviceEnv(): Record<string, string> {
  const extra: Record<string, string> = {};
  const dashDir = process.env.OPENSHIP_DASHBOARD_DIR?.trim();
  if (dashDir) extra.OPENSHIP_DASHBOARD_DIR = dashDir;
  return extra;
}

function plist(flags: UpFlags): string {
  const argv = runArgv(flags);
  const items = argv.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
  const path = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(HOME, ".bun/bin")].join(":");
  const extraEnv = Object.entries(serviceEnv())
    .map(([k, v]) => `<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(LOG_DIR, "up.log")}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, "up.err.log")}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path}</string>${extraEnv}</dict>
</dict>
</plist>
`;
}

function systemdUnit(flags: UpFlags): string {
  const argv = runArgv(flags);
  const execStart = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const extraEnv = Object.entries(serviceEnv())
    .map(([k, v]) => `Environment=${k}=${v}\n`)
    .join("");
  return `[Unit]
Description=Openship control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=2
Environment=NODE_ENV=production
${extraEnv}
[Install]
WantedBy=default.target
`;
}

/* ── public API ─────────────────────────────────────────────────────────── */

export interface ServiceResult {
  kind: ServiceKind;
  /** Human note about what happened / how to inspect it. */
  detail: string;
}

/** Return (don't write) the service definition — for `--dry-run`/debugging. */
export function preview(flags: UpFlags): { kind: ServiceKind; path: string; content: string } {
  const kind = detectKind();
  if (kind === "launchd") return { kind, path: MAC_PLIST, content: plist(flags) };
  if (kind === "systemd-user") return { kind, path: join(HOME, ".config/systemd/user", `${SYSTEMD_NAME}.service`), content: systemdUnit(flags) };
  if (kind === "systemd-system") return { kind, path: `/etc/systemd/system/${SYSTEMD_NAME}.service`, content: systemdUnit(flags) };
  if (kind === "schtasks") return { kind, path: WIN_TASK, content: runArgv(flags).join(" ") };
  return { kind, path: "", content: "" };
}

/** Install + enable + start the persistent service. Idempotent (re-installs). */
export function installAndStart(flags: UpFlags): ServiceResult {
  mkdirSync(LOG_DIR, { recursive: true });
  const kind = detectKind();

  if (kind === "launchd") {
    mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
    // Replace any previous instance first so a re-run picks up new flags.
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${MAC_LABEL}`]);
    writeFileSync(MAC_PLIST, plist(flags));
    const uid = String(process.getuid?.() ?? "");
    let r = run("launchctl", ["bootstrap", `gui/${uid}`, MAC_PLIST]);
    if (!r.ok) r = run("launchctl", ["load", "-w", MAC_PLIST]); // older macOS fallback
    if (!r.ok) throw new Error(`launchctl failed to load the agent: ${r.out}`);
    return { kind, detail: `launchd agent ${MAC_LABEL} (logs: ${LOG_DIR})` };
  }

  if (kind === "systemd-user" || kind === "systemd-system") {
    const sysArgs = kind === "systemd-user" ? ["--user"] : [];
    const unitPath = kind === "systemd-user"
      ? join(HOME, ".config/systemd/user", `${SYSTEMD_NAME}.service`)
      : `/etc/systemd/system/${SYSTEMD_NAME}.service`;
    mkdirSync(unitPath.slice(0, unitPath.lastIndexOf("/")), { recursive: true });
    writeFileSync(unitPath, systemdUnit(flags));
    run("systemctl", [...sysArgs, "daemon-reload"]);
    const r = run("systemctl", [...sysArgs, "enable", "--now", SYSTEMD_NAME]);
    if (!r.ok) throw new Error(`systemctl enable failed: ${r.out}`);
    if (kind === "systemd-user") {
      // Survive reboot without an active login session.
      run("loginctl", ["enable-linger", process.env.USER ?? ""]);
    }
    return { kind, detail: `systemd unit ${SYSTEMD_NAME} (${kind === "systemd-user" ? "--user" : "system"})` };
  }

  if (kind === "schtasks") {
    const tr = runArgv(flags).map((a) => `\\"${a}\\"`).join(" ");
    const r = run("schtasks", ["/Create", "/TN", WIN_TASK, "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR", tr, "/F"]);
    if (!r.ok) throw new Error(`schtasks create failed: ${r.out}`);
    run("schtasks", ["/Run", "/TN", WIN_TASK]);
    return { kind, detail: `Scheduled Task ${WIN_TASK} (best-effort; runs at logon)` };
  }

  throw new Error(
    "No supported service manager found (need systemd on Linux). Run `openship up --foreground` instead, or use docker compose for always-on.",
  );
}

/**
 * Restart the installed service in place (pick up a new bundle after
 * `openship update`). Returns restarted:false when no service is installed —
 * the caller then tells the operator to `openship up` manually.
 */
export function restart(): { restarted: boolean; detail: string } {
  const kind = detectKind();

  if (kind === "launchd") {
    if (!existsSync(MAC_PLIST)) return { restarted: false, detail: "no launchd agent installed" };
    const uid = String(process.getuid?.() ?? "");
    const r = run("launchctl", ["kickstart", "-k", `gui/${uid}/${MAC_LABEL}`]);
    if (!r.ok) return { restarted: false, detail: r.out || "launchctl kickstart failed" };
    // `kickstart` returns 0 as soon as the relaunch REQUEST is accepted — it
    // does NOT wait for the process to come up and stay up. Reporting r.ok as
    // "restarted" is a false positive when the new instance crashes on boot
    // (port already bound, PGlite data-dir lock held by another process, a bad
    // bundle/env). Poll for a live PID so we only claim success once it's
    // actually running.
    for (let i = 0; i < 6; i++) {
      sleepSync(500);
      if (launchdPid() != null) return { restarted: true, detail: `restarted ${MAC_LABEL}` };
    }
    const exit = launchdLastExit();
    return {
      restarted: false,
      detail: `${MAC_LABEL} was killed but didn't stay up${
        exit != null ? ` (last exit ${exit})` : ""
      } — check logs in ${LOG_DIR}`,
    };
  }

  if (kind === "systemd-user" || kind === "systemd-system") {
    const sysArgs = kind === "systemd-user" ? ["--user"] : [];
    const unitPath = kind === "systemd-user"
      ? join(HOME, ".config/systemd/user", `${SYSTEMD_NAME}.service`)
      : `/etc/systemd/system/${SYSTEMD_NAME}.service`;
    if (!existsSync(unitPath)) return { restarted: false, detail: "no systemd unit installed" };
    const r = run("systemctl", [...sysArgs, "restart", SYSTEMD_NAME]);
    return { restarted: r.ok, detail: r.ok ? `restarted ${SYSTEMD_NAME}` : r.out };
  }

  if (kind === "schtasks") {
    run("schtasks", ["/End", "/TN", WIN_TASK]);
    const r = run("schtasks", ["/Run", "/TN", WIN_TASK]);
    return { restarted: r.ok, detail: r.ok ? `restarted ${WIN_TASK}` : r.out };
  }

  return { restarted: false, detail: "no supported service manager" };
}

/** Is the `openship up` service installed on this box, and is it running now? */
export function serviceStatus(): { kind: ServiceKind; installed: boolean; running: boolean } {
  const kind = detectKind();
  if (kind === "launchd") {
    // Installed = the plist exists (agent loaded). Running = it has a LIVE PID —
    // a loaded-but-crashed agent reports no PID, so `launchctl list`'s exit code
    // alone would falsely read as "running".
    return { kind, installed: existsSync(MAC_PLIST), running: launchdPid() != null };
  }
  if (kind === "systemd-user" || kind === "systemd-system") {
    const sysArgs = kind === "systemd-user" ? ["--user"] : [];
    const unitPath =
      kind === "systemd-user"
        ? join(HOME, ".config/systemd/user", `${SYSTEMD_NAME}.service`)
        : `/etc/systemd/system/${SYSTEMD_NAME}.service`;
    return {
      kind,
      installed: existsSync(unitPath),
      running: run("systemctl", [...sysArgs, "is-active", SYSTEMD_NAME]).out.trim() === "active",
    };
  }
  if (kind === "schtasks") {
    const q = run("schtasks", ["/Query", "/TN", WIN_TASK]);
    return { kind, installed: q.ok, running: q.ok && /Running/i.test(q.out) };
  }
  return { kind, installed: false, running: false };
}

/** Stop AND disable the service — it won't restart or return on reboot. */
/**
 * Best-effort reaper for processes still holding our canonical API/dashboard
 * ports. The supervisor stop should tear down the tree, but a previously
 * hard-killed `openship up` (kill -9 / OOM / an old build that leaked the
 * reaper) can orphan the API + dashboard onto the port — leaving `stop`
 * reporting success while `lsof -i :4000` still shows live processes. Scoped to
 * OUR ports (from ports.json) so it never touches an unrelated app. POSIX only.
 */
function sweepOrphanPorts(): void {
  if (process.platform === "win32") return;
  let ports: number[] = [];
  try {
    const raw = readFileSync(join(HOME, ".openship", "ports.json"), "utf8");
    const p = JSON.parse(raw) as { api?: number; dashboard?: number };
    ports = [p.api, p.dashboard].filter((n): n is number => typeof n === "number");
  } catch {
    return; // no remembered ports → nothing scoped to sweep
  }
  const self = process.pid;
  for (const port of ports) {
    const q = run("lsof", ["-ti", `tcp:${port}`]);
    if (!q.ok) continue;
    for (const token of q.out.split(/\s+/).filter(Boolean)) {
      const pid = Number(token);
      if (Number.isInteger(pid) && pid > 1 && pid !== self) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }
}

export function stop(): ServiceResult {
  const kind = detectKind();
  let result: ServiceResult;

  if (kind === "launchd") {
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${MAC_LABEL}`]);
    if (existsSync(MAC_PLIST)) rmSync(MAC_PLIST, { force: true });
    result = { kind, detail: `launchd agent ${MAC_LABEL} stopped + removed` };
  } else if (kind === "systemd-user" || kind === "systemd-system") {
    const sysArgs = kind === "systemd-user" ? ["--user"] : [];
    run("systemctl", [...sysArgs, "disable", "--now", SYSTEMD_NAME]);
    const unitPath = kind === "systemd-user"
      ? join(HOME, ".config/systemd/user", `${SYSTEMD_NAME}.service`)
      : `/etc/systemd/system/${SYSTEMD_NAME}.service`;
    if (existsSync(unitPath)) rmSync(unitPath, { force: true });
    run("systemctl", [...sysArgs, "daemon-reload"]);
    result = { kind, detail: `systemd unit ${SYSTEMD_NAME} stopped + disabled` };
  } else if (kind === "schtasks") {
    run("schtasks", ["/End", "/TN", WIN_TASK]);
    run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"]);
    result = { kind, detail: `Scheduled Task ${WIN_TASK} stopped + removed` };
  } else {
    result = { kind, detail: "no supported service manager — nothing to stop" };
  }

  // Reap any leftovers on our ports so `stop` genuinely frees them.
  sweepOrphanPorts();
  return result;
}
