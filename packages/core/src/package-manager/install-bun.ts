import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { run, versionOf } from "./execute";

/** Bun images need a native installer because npm may not be present. */
export function installBunBinary(version: string): void {
  const platform = process.platform,
    arch = process.arch === "arm64" ? "aarch64" : process.arch;
  if (!["linux", "darwin"].includes(platform) || !["x64", "aarch64"].includes(arch))
    throw new Error("Unsupported platform for managed Bun installation.");
  const musl =
    platform === "linux" &&
    (fs.existsSync("/lib/ld-musl-x86_64.so.1") || fs.existsSync("/lib/ld-musl-aarch64.so.1"));
  const name =
    "@oven/bun-" +
    platform +
    "-" +
    arch +
    (musl ? "-musl" : "") +
    (arch === "x64" ? "-baseline" : "");
  const temp = fs.mkdtempSync(path.join(tmpdir(), "openship-bun-toolchain-"));
  const destination = fs.realpathSync(process.execPath),
    staging = destination + ".openship-" + process.pid;
  try {
    fs.writeFileSync(path.join(temp, "package.json"), "{}");
    if (!run("bun", ["add", "--cwd", temp, "--ignore-scripts", name + "@" + version]))
      throw new Error("Unable to fetch the selected Bun binary.");
    const binary = path.join(temp, "node_modules", name, "bin", "bun");
    if (versionOf(binary) !== version)
      throw new Error("Downloaded Bun binary has the wrong version.");
    fs.copyFileSync(binary, staging);
    fs.chmodSync(staging, 0o755);
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(staging, { force: true });
  }
}
