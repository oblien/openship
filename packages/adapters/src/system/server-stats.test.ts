import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_STATS_COMMAND } from "./server-stats";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtures(os: string, pageSize = 16384) {
  const dir = mkdtempSync(join(tmpdir(), "openship-stats-"));
  dirs.push(dir);
  const command = (name: string, body: string) =>
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  command("uname", `printf '%s\\n' '${os}'`);
  command("sleep", "exit 0");
  command(
    "df",
    "printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted' '/dev/disk 12345678901 2345678901 10000000000 19% /'",
  );
  command(
    "iostat",
    "printf '%s\\n' 'disk0 cpu load average' 'KB/t tps MB/s us sy id 1m 5m 15m' '20 1 2 5 5 90 1.2 2.3 3.4' '20 1 2 15 25 60 1.2 2.3 3.4'",
  );
  command(
    "vm_stat",
    `printf '%s\\n' 'Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)' 'Pages free: 10000.' 'Pages inactive: 20000.' 'Pages speculative: 3000.'`,
  );
  command(
    "sysctl",
    `case "$2" in hw.memsize) echo 17179869184 ;; kern.boottime) echo '{ sec = 1000, usec = 0 }' ;; vm.loadavg) echo '{ 1.2 2.3 3.4 }' ;; *) exit 1 ;; esac`,
  );
  command("date", "echo 4600");
  // Substitute only the host's /proc inputs. Execute the production awk programs.
  writeFileSync(join(dir, "stat0"), "cpu 100 10 20 400 50 6 7 8 0 0\n");
  writeFileSync(join(dir, "stat1"), "cpu 130 10 40 430 60 8 10 13 0 0\n");
  writeFileSync(join(dir, "meminfo"), "MemTotal: 16777216 kB\nMemAvailable: 4194304 kB\n");
  command(
    "awk",
    `case "\${2-}" in
    /proc/stat) if [ -f "$STATS_FIXTURE/sampled" ]; then file=stat1; else file=stat0; touch "$STATS_FIXTURE/sampled"; fi; exec /usr/bin/awk "$1" "$STATS_FIXTURE/$file" ;;
    /proc/meminfo) exec /usr/bin/awk "$1" "$STATS_FIXTURE/meminfo" ;;
    *) exec /usr/bin/awk "$@" ;;
  esac`,
  );
  command(
    "cat",
    `case "$1" in /proc/uptime) echo '3600.5 0.0' ;; /proc/loadavg) echo '1.2 2.3 3.4 1/2 3' ;; *) exec /bin/cat "$@" ;; esac`,
  );
  return {
    command,
    env: { ...process.env, STATS_FIXTURE: dir, PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin` },
  };
}
function sample(env = process.env, shell = "/bin/sh") {
  return JSON.parse(
    execFileSync(shell, ["-c", SERVER_STATS_COMMAND], { env, encoding: "utf8", timeout: 12000 }),
  );
}
function valid(stats: ReturnType<typeof sample>) {
  expect(stats.cpu).toBeGreaterThanOrEqual(0);
  expect(stats.cpu).toBeLessThanOrEqual(100);
  expect(stats.memTotal).toBeGreaterThan(0);
  expect(stats.memUsed + stats.memAvail).toBe(stats.memTotal);
  for (const key of ["memUsed", "memAvail", "diskTotal", "diskUsed", "diskAvail"]) {
    expect(Number.isSafeInteger(stats[key])).toBe(true);
    expect(stats[key]).toBeGreaterThanOrEqual(0);
  }
  for (const key of ["uptime", "load1", "load5", "load15"]) {
    expect(typeof stats[key]).toBe("string");
    expect(Number.isFinite(Number(stats[key]))).toBe(true);
    expect(Number(stats[key])).toBeGreaterThanOrEqual(0);
  }
}

describe("server monitor host command", () => {
  it.each([4096, 16384])("reads macOS interval CPU and memory with %i-byte pages", (pageSize) => {
    const stats = sample(fixtures("Darwin", pageSize).env);
    valid(stats);
    expect(stats).toMatchObject({
      cpu: 40,
      memTotal: 17179869184,
      memAvail: 33000 * pageSize,
      diskTotal: 12345678901 * 1024,
      uptime: "3600",
      load1: "1.2",
      load5: "2.3",
      load15: "3.4",
    });
  });
  it("reads Linux counters including interrupts, steal and idle I/O wait", () => {
    const stats = sample(fixtures("Linux").env);
    valid(stats);
    expect(stats).toMatchObject({
      cpu: 60,
      memTotal: 17179869184,
      memAvail: 4294967296,
      uptime: "3600.5",
    });
  });
  it("fails a broken macOS probe instead of emitting invented zero statistics", () => {
    const f = fixtures("Darwin");
    f.command("vm_stat", "exit 1");
    const r = spawnSync("/bin/sh", ["-c", SERVER_STATS_COMMAND], { env: f.env, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
  it("rejects unsupported hosts", () => {
    const r = spawnSync("/bin/sh", ["-c", SERVER_STATS_COMMAND], {
      env: fixtures("Unknown").env,
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Unsupported server operating system");
  });
  it("runs against the actual Linux or macOS host without extra dependencies", () => {
    valid(sample());
  });
  if (process.platform === "darwin") {
    it("also works through macOS's default zsh login shell", () => {
      valid(sample(process.env, "/bin/zsh"));
    });
  }
});
