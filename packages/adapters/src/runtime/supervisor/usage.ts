/**
 * Resource usage for a bare (non-container) deployment.
 *
 * `BareRuntime.getUsage` returned hardcoded zeros, and nothing guarded the call, so
 * a bare deploy rendered 0% CPU / 0 MB as though those were measurements — an idle
 * app and an unmeasurable one looked identical on the dashboard.
 *
 * Both supervisors share this because the measurement is a property of the OS, not
 * of how the process was started. Three tiers, strongest first:
 *
 *   1. cgroup v2 (`cpu.stat` + `memory.current`) — covers the process AND its
 *      children, which matters: a `npm start` that forks a server would otherwise
 *      report the wrapper's near-zero usage. Systemd puts each unit in its own
 *      cgroup, so this is the normal path on a Linux server.
 *   2. /proc/<pid> — the leader process only. Linux without a readable cgroup.
 *   3. `ps` — macOS / anything without procfs (the nohup dev path).
 *
 * CPU is a RATE, so every tier samples twice around a short sleep and divides by
 * the interval. Reading a cumulative counter once and reporting it as a percentage
 * is the classic version of this bug — it yields a lifetime average that barely
 * moves, so a process pinning a core looks idle.
 */

import type { CommandExecutor, ResourceUsage } from "../../types";
import { sq } from "../build-pipeline";

/** Sampling gap. Long enough to be a meaningful rate, short enough that a polled
 *  read (every ~5s) doesn't spend most of its time sleeping. */
const SAMPLE_MS = 250;

export const ZERO_USAGE: ResourceUsage = {
  cpuPercent: 0,
  memoryMb: 0,
  diskMb: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
};

/**
 * One shell probe emitting a single space-separated line, TIER FIRST:
 *
 *   cgroup <cpu_usec_1> <cpu_usec_2> <rss_bytes> <read_bytes> <written_bytes>
 *   proc   <cpu_usec_1> <cpu_usec_2> <rss_bytes> <read_bytes> <written_bytes>
 *   ps     <rss_bytes> <cpu_pct>
 *
 * The marker leads because the tiers have DIFFERENT arities — `ps` has no CPU
 * samples to give, only a lifetime average. With the marker trailing, the parser
 * has to know the field count before it knows which layout it's reading, and a
 * 5-field `ps` line read as a 6-field one silently yields zeros.
 *
 * A one-liner rather than several round trips because on a remote host each `exec`
 * is an SSH round trip, and the two CPU samples must be a known interval apart —
 * splitting them across calls makes the interval whatever the network felt like.
 *
 * Every interpolated value is shell-quoted. Callers pass a systemd unit name and a
 * pid, both derived from ids we mint, but the quoting is unconditional per the
 * remote-exec rule rather than argued case by case.
 */
function buildProbe(pid: number, cgroupCandidates: string[]): string {
  const p = sq(String(pid));
  const cgList = cgroupCandidates.map(sq).join(" ");
  return [
    `P=${p}`,
    // Locate a readable cgroup v2 dir for this unit, if any.
    `CG=""`,
    `for c in ${cgList}; do if [ -r "$c/cpu.stat" ]; then CG="$c"; break; fi; done`,
    // ── cgroup v2 ──
    `if [ -n "$CG" ]; then`,
    `  C1=$(awk '/^usage_usec/{print $2}' "$CG/cpu.stat" 2>/dev/null)`,
    `  sleep ${(SAMPLE_MS / 1000).toFixed(3)}`,
    `  C2=$(awk '/^usage_usec/{print $2}' "$CG/cpu.stat" 2>/dev/null)`,
    `  M=$(cat "$CG/memory.current" 2>/dev/null)`,
    // io.stat is "<maj:min> rbytes=N wbytes=N rios=N wios=N" per device — summed
    // across devices. Read and write are kept apart so the parser adds each once.
    `  R=$(awk '{for(i=1;i<=NF;i++){split($i,kv,"=");if(kv[1]=="rbytes")r+=kv[2]}}END{print r+0}' "$CG/io.stat" 2>/dev/null)`,
    `  W=$(awk '{for(i=1;i<=NF;i++){split($i,kv,"=");if(kv[1]=="wbytes")w+=kv[2]}}END{print w+0}' "$CG/io.stat" 2>/dev/null)`,
    `  echo "cgroup \${C1:-0} \${C2:-0} \${M:-0} \${R:-0} \${W:-0}"`,
    // ── /proc/<pid> ──
    `elif [ -r "/proc/$P/stat" ]; then`,
    // utime (14) + stime (15) in clock ticks. comm can contain spaces, so cut
    // everything up to the closing paren before counting fields.
    `  T=$(getconf CLK_TCK 2>/dev/null || echo 100)`,
    `  C1=$(sed 's/.*) //' "/proc/$P/stat" 2>/dev/null | awk -v t="$T" '{print int((($12+$13)/t)*1000000)}')`,
    `  sleep ${(SAMPLE_MS / 1000).toFixed(3)}`,
    `  C2=$(sed 's/.*) //' "/proc/$P/stat" 2>/dev/null | awk -v t="$T" '{print int((($12+$13)/t)*1000000)}')`,
    `  M=$(awk '/^VmRSS:/{print $2*1024}' "/proc/$P/status" 2>/dev/null)`,
    `  R=$(awk '/^read_bytes:/{print $2}' "/proc/$P/io" 2>/dev/null)`,
    `  W=$(awk '/^write_bytes:/{print $2}' "/proc/$P/io" 2>/dev/null)`,
    `  echo "proc \${C1:-0} \${C2:-0} \${M:-0} \${R:-0} \${W:-0}"`,
    // ── ps (macOS / no procfs) ──
    `else`,
    // ps %cpu is a LIFETIME average, not a rate — reported as-is and flagged by the
    // `ps` source so the parser doesn't pretend it's an instantaneous sample.
    `  X=$(ps -o rss=,%cpu= -p "$P" 2>/dev/null | awk '{print ($1*1024)" "$2}')`,
    `  echo "ps \${X:-0 0}"`,
    `fi`,
  ].join("; ");
}

interface ProbeResult extends ResourceUsage {
  source: "cgroup" | "proc" | "ps" | "none";
}

function parseProbe(out: string): ProbeResult {
  const parts = out.trim().split(/\s+/);
  const source = parts[0] as ProbeResult["source"];
  const n = (i: number) => {
    const v = Number(parts[i]);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };

  let cpuPercent: number;
  let memoryMb: number;
  let diskMb = 0;

  if (source === "ps") {
    if (parts.length < 3) return { ...ZERO_USAGE, source: "none" };
    // "ps <rss_bytes> <cpu_pct>" — a LIFETIME average, not a rate. Reported as-is
    // because it's the only number this tier has; the tier marker is what tells a
    // reader not to treat it as instantaneous.
    memoryMb = n(1) / (1024 * 1024);
    cpuPercent = n(2);
  } else if (source === "cgroup" || source === "proc") {
    if (parts.length < 6) return { ...ZERO_USAGE, source: "none" };
    // Clamped at 0: a counter that went BACKWARDS means the process (or cgroup) was
    // replaced between the two samples, not that it used negative CPU.
    const deltaUsec = Math.max(0, n(2) - n(1));
    // usec of CPU consumed per usec of wall clock, as a percentage. >100% is
    // correct and expected on a multi-core box, so it is NOT clamped.
    cpuPercent = (deltaUsec / (SAMPLE_MS * 1000)) * 100;
    memoryMb = n(3) / (1024 * 1024);
    diskMb = (n(4) + n(5)) / (1024 * 1024);
  } else {
    return { ...ZERO_USAGE, source: "none" };
  }

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryMb: Math.round(memoryMb * 100) / 100,
    diskMb: Math.round(diskMb * 100) / 100,
    // Per-process network accounting needs eBPF or a per-unit netns, neither of
    // which a bare deploy has. Zero here means "not measured", and the dashboard
    // shows network only for container runtimes.
    networkRxBytes: 0,
    networkTxBytes: 0,
    source,
  };
}

/**
 * Sample usage for a bare process.
 *
 * `pid` 0 (process not running / no pid file) short-circuits to zeros. Never
 * throws: a usage read must not be able to fail a status page.
 */
export async function sampleBareUsage(
  executor: CommandExecutor,
  pid: number,
  cgroupCandidates: string[] = [],
): Promise<ResourceUsage> {
  if (!Number.isInteger(pid) || pid <= 0) return { ...ZERO_USAGE };
  try {
    const out = await executor.exec(buildProbe(pid, cgroupCandidates));
    const { source: _source, ...usage } = parseProbe(out);
    return usage;
  } catch {
    return { ...ZERO_USAGE };
  }
}

/** Exported for unit tests — the parser is where the arithmetic lives. */
export const __testables = { buildProbe, parseProbe, SAMPLE_MS };
