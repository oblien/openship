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
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  publicUrl?: string;
  /** false → pass --no-ui */
  ui?: boolean;
  uiVersion?: string;
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
  if (flags.publicUrl) a.push("--public-url", flags.publicUrl);
  if (flags.ui === false) a.push("--no-ui");
  if (flags.uiVersion) a.push("--ui-version", flags.uiVersion);
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

function plist(flags: UpFlags): string {
  const argv = runArgv(flags);
  const items = argv.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
  const path = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(HOME, ".bun/bin")].join(":");
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
  <dict><key>PATH</key><string>${path}</string></dict>
</dict>
</plist>
`;
}

function systemdUnit(flags: UpFlags): string {
  const argv = runArgv(flags);
  const execStart = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
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

/** Stop AND disable the service — it won't restart or return on reboot. */
export function stop(): ServiceResult {
  const kind = detectKind();

  if (kind === "launchd") {
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${MAC_LABEL}`]);
    if (existsSync(MAC_PLIST)) rmSync(MAC_PLIST, { force: true });
    return { kind, detail: `launchd agent ${MAC_LABEL} stopped + removed` };
  }

  if (kind === "systemd-user" || kind === "systemd-system") {
    const sysArgs = kind === "systemd-user" ? ["--user"] : [];
    run("systemctl", [...sysArgs, "disable", "--now", SYSTEMD_NAME]);
    const unitPath = kind === "systemd-user"
      ? join(HOME, ".config/systemd/user", `${SYSTEMD_NAME}.service`)
      : `/etc/systemd/system/${SYSTEMD_NAME}.service`;
    if (existsSync(unitPath)) rmSync(unitPath, { force: true });
    run("systemctl", [...sysArgs, "daemon-reload"]);
    return { kind, detail: `systemd unit ${SYSTEMD_NAME} stopped + disabled` };
  }

  if (kind === "schtasks") {
    run("schtasks", ["/End", "/TN", WIN_TASK]);
    run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"]);
    return { kind, detail: `Scheduled Task ${WIN_TASK} stopped + removed` };
  }

  return { kind, detail: "no supported service manager — nothing to stop" };
}
