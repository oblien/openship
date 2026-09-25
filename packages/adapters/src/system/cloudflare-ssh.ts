import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { cloudflareSshUrl } from "@repo/core";

interface CloudflaredOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
}

/** Only the installation's environment can select a local executable. */
export function resolveCloudflaredExecutable(options: CloudflaredOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : { delimiter, isAbsolute, join };
  const isFile = options.isFile ?? ((file: string) => {
    try { return statSync(file).isFile(); } catch { return false; }
  });
  const configured = env.OPENSHIP_CLOUDFLARED_PATH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || !isFile(configured)) {
      throw new Error("OPENSHIP_CLOUDFLARED_PATH must point to an installed cloudflared executable.");
    }
    return configured;
  }
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const directory of search.split(path.delimiter)) {
    // Never search the working directory (including an empty PATH component).
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (isFile(candidate)) return candidate;
  }
  throw new Error("Cloudflare Access requires cloudflared on the machine running OpenShip. Install it or set OPENSHIP_CLOUDFLARED_PATH, then retry.");
}

/** Generated from a fixed command and validated hostname, never raw SSH options. */
export function buildCloudflareProxyCommand(host: string, options: CloudflaredOptions = {}): string {
  cloudflareSshUrl(host);
  const executable = resolveCloudflaredExecutable(options);
  // OpenSSH expands percent tokens even inside quotes. Windows command parsing
  // has additional expansion characters; reject these in operator-owned paths.
  if (/[\x00-\x1f\x7f%]/.test(executable)) throw new Error("Unsupported cloudflared executable path.");
  let quoted: string;
  if ((options.platform ?? process.platform) === "win32") {
    if (/[!^"&|<>]/.test(executable)) throw new Error("Unsupported cloudflared executable path.");
    quoted = `"${executable.replaceAll("\\", "/")}"`;
  } else {
    quoted = `'${executable.replaceAll("'", "'\\''")}'`;
  }
  return `${quoted} access ssh --hostname ${host}`;
}

/** Password/key SSH uses ssh2 over cloudflared's byte stream, without a shell,
 * temporary credentials, or a second direct connection to the destination. */
export function openCloudflareSshStream(host: string): Duplex {
  cloudflareSshUrl(host);
  const child = spawn(resolveCloudflaredExecutable(), ["access", "ssh", "--hostname", host], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Wait for the process result before forwarding EOF. Otherwise ssh2 reports
  // only "Connection lost before handshake" before stderr/the exit code arrive.
  const output = new PassThrough();
  child.stdout.pipe(output, { end: false });
  const stream = Duplex.from({ writable: child.stdin, readable: output });
  // ssh2 attaches its listener immediately after this function returns. Keep an
  // error floor for teardown and for a subprocess that fails before that handoff.
  stream.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.once("error", (err) => stream.destroy(new Error(`Cloudflare Access could not start: ${err.message}`)));
  child.once("close", (code) => {
    if (stream.destroyed) return;
    if (code === 0) output.end();
    else stream.destroy(new Error(`Cloudflare Access connection failed: ${stderr.trim() || `cloudflared exited with code ${code}`}`));
  });
  stream.once("close", () => { if (child.exitCode === null) child.kill(); });
  return stream;
}
