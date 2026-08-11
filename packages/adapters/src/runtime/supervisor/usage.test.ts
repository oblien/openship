import { describe, it, expect, vi } from "vitest";
import { sampleBareUsage, ZERO_USAGE, __testables } from "./usage";
import type { CommandExecutor } from "../../types";

const { parseProbe, buildProbe, SAMPLE_MS } = __testables;

function fakeExecutor(out: string | Error): CommandExecutor {
  return {
    exec: vi.fn(async () => {
      if (out instanceof Error) throw out;
      return out;
    }),
  } as unknown as CommandExecutor;
}

describe("parseProbe", () => {
  it("derives CPU percent from the delta between the two samples, not the raw counter", () => {
    // 250ms of wall clock = 250_000 usec. Half a core busy → 125_000 usec of CPU.
    const half = parseProbe(`cgroup 1000000 ${1_000_000 + 125_000} 0 0 0`);
    expect(half.cpuPercent).toBeCloseTo(50, 5);

    // Same absolute counter, no delta → idle. A single-read implementation would
    // report a large lifetime average here instead.
    expect(parseProbe("cgroup 1000000 1000000 0 0 0").cpuPercent).toBe(0);
  });

  it("does not clamp above 100% — multi-core usage is real, not an error", () => {
    const twoCores = parseProbe(`cgroup 0 ${SAMPLE_MS * 1000 * 2} 0 0 0`);
    expect(twoCores.cpuPercent).toBeCloseTo(200, 5);
  });

  it("converts memory bytes to MB and sums read+write into disk IO", () => {
    const r = parseProbe(`cgroup 0 0 ${64 * 1024 * 1024} ${2 * 1024 * 1024} ${3 * 1024 * 1024}`);
    expect(r.memoryMb).toBeCloseTo(64, 2);
    expect(r.diskMb).toBeCloseTo(5, 2);
  });

  it("reads the ps tier's different column layout (rss, cpu%) rather than as samples", () => {
    // "ps <rss_bytes> <cpu_pct>" — only 3 fields. This tier is why the marker leads:
    // read as a 6-field cgroup line it fails the arity check and yields all zeros.
    const r = parseProbe(`ps ${32 * 1024 * 1024} 17.5`);
    expect(r.memoryMb).toBeCloseTo(32, 2);
    expect(r.cpuPercent).toBeCloseTo(17.5, 2);
  });

  it("never reports negative CPU when a counter resets (process replaced mid-sample)", () => {
    expect(parseProbe("proc 5000000 10 0 0 0").cpuPercent).toBe(0);
  });

  it("returns zeros for truncated or garbage output", () => {
    expect(parseProbe("")).toMatchObject({ ...ZERO_USAGE, source: "none" });
    expect(parseProbe("nonsense")).toMatchObject({ source: "none" });
    expect(parseProbe("cgroup a b c d e").cpuPercent).toBe(0);
  });

  it("leaves network at zero — a bare process has no per-process accounting", () => {
    const r = parseProbe("cgroup 0 250000 1048576 0 0");
    expect(r.networkRxBytes).toBe(0);
    expect(r.networkTxBytes).toBe(0);
  });
});

describe("buildProbe", () => {
  it("shell-quotes the pid and every cgroup candidate", () => {
    const cmd = buildProbe(4242, ["/sys/fs/cgroup/system.slice/openship-a.service"]);
    expect(cmd).toContain("P='4242'");
    expect(cmd).toContain("'/sys/fs/cgroup/system.slice/openship-a.service'");
  });

  it("samples CPU twice around one sleep, so the interval is known", () => {
    const cmd = buildProbe(1, []);
    expect(cmd.match(/sleep /g)?.length).toBe(2); // cgroup tier + proc tier
    expect(cmd).toContain("C1=");
    expect(cmd).toContain("C2=");
  });

  it("prefers cgroup, then /proc, then ps", () => {
    const cmd = buildProbe(1, ["/cg"]);
    expect(cmd.indexOf("cpu.stat")).toBeLessThan(cmd.indexOf("/proc/$P/stat"));
    expect(cmd.indexOf("/proc/$P/stat")).toBeLessThan(cmd.indexOf("ps -o"));
  });
});

describe("sampleBareUsage", () => {
  it("short-circuits without touching the host when there is no pid", async () => {
    const exec = fakeExecutor("");
    expect(await sampleBareUsage(exec, 0)).toEqual(ZERO_USAGE);
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it("returns zeros instead of throwing when the host errors — a usage read must not fail a status page", async () => {
    await expect(
      sampleBareUsage(fakeExecutor(new Error("ssh closed")), 123),
    ).resolves.toEqual(ZERO_USAGE);
  });

  it("strips the tier marker from the returned usage", async () => {
    const r = await sampleBareUsage(fakeExecutor("cgroup 0 250000 1048576 0 0"), 123);
    expect(r).not.toHaveProperty("source");
    expect(r.cpuPercent).toBeCloseTo(100, 5);
    expect(r.memoryMb).toBeCloseTo(1, 2);
  });
});
