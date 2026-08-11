import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

import {
  explainHostChannelCause,
  hostFirewallRule,
  HOST_CHANNEL_NOT_PROVISIONED,
  HOST_CHANNEL_UNPROVISIONED,
} from "@repo/core";

import type { CommandExecutor, SshConfig } from "../types";
import { HostChannelUnavailableError } from "./errors";
import { LocalExecutor } from "./local-executor";
import { probeTcpDetailed, type TcpProbeFailure, type TcpProbeResult } from "./reachability";
import { SshExecutor } from "./ssh-executor";
import { SystemSshExecutor } from "./system-ssh-executor";

export { wrapLocalBuildCommand } from "./local-shell";
export { LocalExecutor } from "./local-executor";
export { SshExecutor } from "./ssh-executor";
export { SystemSshExecutor } from "./system-ssh-executor";

/**
 * One shared local executor. LocalExecutor holds no instance state (no client, no
 * channel, `dispose()` is a no-op), and every instance reaches the same machine, so
 * separate objects were pure allocation — and worse, they defeated per-executor
 * memoization: caches keyed by "which box is this" (see `resolveOurEdgeContainer`)
 * missed on every call because each platform construction handed them a new object.
 */
const localExecutor = new LocalExecutor();

export function createExecutor(ssh?: SshConfig): CommandExecutor {
  if (ssh) {
    // "agent" auth routes through the OS `ssh` binary (see SystemSshExecutor);
    // password/key auth use the in-process ssh2 client.
    if (ssh.useSystemSsh) return new SystemSshExecutor(ssh);
    return new SshExecutor(ssh);
  }
  return localExecutor;
}

/**
 * Executor for HOST-OS operations ("this machine") that works whether openship
 * runs bare OR in a container.
 *
 * Bare: `LocalExecutor` — commands run on the host directly.
 *
 * Containerized: a container can't apt/systemctl/edit files on its HOST, so when
 * `OPENSHIP_HOST_SSH_HOST` is set (the `openship up` CLI provisions this + a key
 * + the compose `extra_hosts: host.docker.internal:host-gateway`) we reach the
 * host over SSH via `host.docker.internal` — the docker-bridge gateway, an
 * INTERNAL address, never the public IP. Reuses the standard remote-server
 * pipeline (`SshExecutor`), so foreign-proxy handover / host system config land
 * on the host. Not more privilege than the mounted docker socket already grants.
 */
/** Host control explicitly switched off by the operator (`--no-host-control`). */
export function hostControlDisabled(): boolean {
  return process.env.OPENSHIP_HOST_CONTROL?.trim().toLowerCase() === "false";
}

/**
 * Are WE running inside a container?
 *
 * The distinction that matters for {@link createHostExecutor}: `LocalExecutor`
 * targets the host on a bare install and the CONTAINER's own namespace in a
 * containerized one. Those are completely different machines, and the difference is
 * invisible in the command output — `docker volume inspect` happily returns a host
 * path that does not exist where the command ran.
 *
 * `/.dockerenv` is Docker's own marker (the same probe domain.service.ts:368 uses);
 * the cgroup scan covers podman and Docker configurations that omit it. Sync reads
 * because callers are synchronous, and both are single small local files.
 */
function runningInContainer(): boolean {
  if (process.env.OPENSHIP_IN_CONTAINER?.trim().toLowerCase() === "true") return true;
  try {
    if (existsSync("/.dockerenv")) return true;
  } catch {
    /* fall through to the cgroup probe */
  }
  try {
    return /\b(docker|containerd|podman|kubepods)\b/.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    // No procfs (macOS/Windows dev) — those are never the containerized API.
    return false;
  }
}

function hostChannelPort(): number {
  const raw = Number(process.env.OPENSHIP_HOST_SSH_PORT || "22");
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 22;
}

function hostChannelUser(): string {
  return process.env.OPENSHIP_HOST_SSH_USER?.trim() || "root";
}

/**
 * The host channel's private key, or why it can't be used.
 *
 * One reader for both doors — {@link hostChannelHealth} reports this state as
 * `key_unreadable` and {@link createHostExecutor} has to refuse the channel over it,
 * and they spelled the read and the prose separately, so the banner could call a box
 * degraded while a deploy on the same box died in different words (#509).
 *
 * An EMPTY file counts as unreadable: the shipped compose mounts `/dev/null` at the
 * key path when no key was provisioned, and a zero-byte key reaches ssh2 as "no
 * credentials at all" — an error that names neither the channel nor the fix.
 */
function readHostChannelKey(
  keyPath: string,
): { key: string; reason?: undefined } | { key?: undefined; reason: string } {
  let contents: string;
  try {
    contents = readFileSync(keyPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reason: `Cannot read the host SSH key at ${keyPath} (${detail}).` };
  }
  if (!contents.trim()) return { reason: `The host SSH key at ${keyPath} is empty.` };
  return { key: contents };
}

/**
 * The Docker bridge subnet as seen from INSIDE this container, in CIDR form
 * (`172.18.0.0/16`) — i.e. the source range a host firewall rule must allow.
 *
 * Read off our own interface rather than asked of the daemon: this is the address
 * the host's filter/INPUT chain actually sees, and it stays available on a path
 * whose whole purpose is diagnosing a broken channel.
 */
export function containerBridgeCidr(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const prefix = Number(addr.cidr?.split("/")[1]);
      if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) continue;
      const octets = addr.address.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) continue;
      const asInt =
        ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      const net = (asInt & mask) >>> 0;
      return `${(net >>> 24) & 0xff}.${(net >>> 16) & 0xff}.${(net >>> 8) & 0xff}.${net & 0xff}/${prefix}`;
    }
  }
  return null;
}

export type HostChannelCode =
  | "ok"
  /** Bare install — LocalExecutor IS the host, nothing to dial. */
  | "not_applicable"
  /** `--no-host-control`. */
  | "disabled"
  /** Containerized with no `OPENSHIP_HOST_SSH_HOST`. */
  | "not_configured"
  | "key_unreadable"
  /** Configured, but the TCP connection to the host SSH port never completed. */
  | "unreachable";

export interface HostChannelHealth {
  /** Host ("this machine") operations can be performed at all. */
  ok: boolean;
  code: HostChannelCode;
  host?: string;
  port?: number;
  /** `user@host:port`, when there is an endpoint. */
  target?: string;
  /** Operator-facing remedy. Present whenever `ok` is false. */
  hint?: string;
  /** A ready-to-paste firewall rule, when a packet filter is the likely cause. */
  rule?: string;
  /**
   * How the dial failed, on `unreachable`. Refines the code rather than extending
   * it: what an operator does next differs per cause, but "this box can't drive its
   * host" is one state to every consumer (banner, server list, terminal), and
   * splitting the code would fan out into all of them for no gain.
   */
  cause?: TcpProbeFailure;
}

/**
 * Turn a failed dial into a remedy that matches the actual fault.
 *
 * The prose and the rule syntax live in @repo/core so the CLI preflight, the doctor
 * row and the dashboard banner say the same thing; this function's job is the part
 * only a process inside the container can do — measure the bridge CIDR, and decide
 * from the probe which shape of fault it is.
 *
 * `rule` stays OUT of `hint`. Only a dropped packet is the firewall shape: a refusal
 * arrived somewhere and an unresolved name never left, so a ufw rule fixes neither,
 * and offering one anyway sends the operator to edit something that was never the
 * problem and then to distrust the whole diagnosis (#490, #482). Callers that show
 * both put them together themselves.
 */
/** The errno names the class of fault, the message names the instance — keep both
 *  unless node already put the errno inside the message. */
function probeDetail(probe: Extract<TcpProbeResult, { ok: false }>): string | undefined {
  const { code, message } = probe;
  if (code && message && !message.includes(code)) return `${code}: ${message}`;
  return code ?? message;
}

function explainDialFailure(
  probe: Extract<TcpProbeResult, { ok: false }>,
  host: string,
  port: number,
  target: string,
): { hint: string; rule?: string } {
  const { headline, body, firewallShaped } = explainHostChannelCause(probe.reason, {
    target,
    host,
    detail: probeDetail(probe),
  });
  const hint = body ? `${headline}. ${body}` : `${headline}.`;
  if (!firewallShaped) return { hint };
  // "unknown": from in here we cannot see which firewall the host runs — no host
  // package list, no systemd. An empty CIDR list falls back to Docker's default pool.
  const cidr = containerBridgeCidr();
  return { hint, rule: hostFirewallRule("unknown", cidr ? [cidr] : [], port) };
}

/**
 * Can this instance actually drive its host? Cheap enough to call on every page
 * load: one TCP handshake to the host SSH port, or no I/O at all when the answer
 * is decided by env.
 *
 * Exists because {@link createHostExecutor} has no "configured but unreachable"
 * state — it returns an executor that has not dialed anything, so a filtered
 * bridge only surfaces later, as a handshake timeout inside whatever operation
 * happened to need the host (#490). Deliberately NOT called from
 * `createHostExecutor`: that is synchronous by contract and sits on every host-op
 * path, where an extra probe per call would be pure latency.
 */
export async function hostChannelHealth(timeoutMs = 2_500): Promise<HostChannelHealth> {
  if (hostControlDisabled()) {
    return {
      ok: false,
      code: "disabled",
      hint: "Host control is off (OPENSHIP_HOST_CONTROL=false). Re-run `openship up` without --no-host-control.",
    };
  }

  const host = process.env.OPENSHIP_HOST_SSH_HOST?.trim();
  if (!host) {
    if (runningInContainer()) {
      // No endpoint, so nothing is dialed and there is no `target` — the observation
      // and the remedy are all a consumer gets, and both come from @repo/core so the
      // banner, the boot log and the doctor row can't word this differently (#509).
      return {
        ok: false,
        code: "not_configured",
        hint: `${HOST_CHANNEL_UNPROVISIONED} ${HOST_CHANNEL_NOT_PROVISIONED}`,
      };
    }
    return { ok: true, code: "not_applicable" };
  }

  const port = hostChannelPort();
  const target = `${hostChannelUser()}@${host}:${port}`;
  const keyPath = process.env.OPENSHIP_HOST_SSH_KEY?.trim();
  if (keyPath) {
    const { reason } = readHostChannelKey(keyPath);
    if (reason) {
      return {
        ok: false,
        code: "key_unreadable",
        host,
        port,
        target,
        hint: `${reason} ${HOST_CHANNEL_NOT_PROVISIONED}`,
      };
    }
  }

  const probe = await probeTcpDetailed(host, port, timeoutMs);
  if (probe.ok) {
    return { ok: true, code: "ok", host, port, target };
  }

  return {
    ok: false,
    code: "unreachable",
    host,
    port,
    target,
    cause: probe.reason,
    ...explainDialFailure(probe, host, port, target),
  };
}

/**
 * An executor that runs nothing and names the reason on every call.
 *
 * `createHostExecutor()` fails at CONSTRUCTION when the host channel is
 * unavailable, which is right for a caller that wants to touch the host and wrong
 * for one that only needs an executor HANDLE: resolving a local server row for a
 * deploy that reaches its workload through the mounted Docker socket. That took
 * down every deploy to "This Server" the moment host control was switched off — a
 * switch operators reach for exactly when the channel looks broken (#490), so the
 * breakage arrived attached to the advice.
 *
 * Substituting this keeps the socket path working and moves the failure to the
 * operation that actually needs the host, with the remedy attached. It is NOT a
 * fallback to the container's own filesystem: silently running host ops against a
 * lookalike FS is the hazard `createHostExecutor` throws to prevent, and every
 * method here refuses rather than pretending (an `exists()` that answered `false`
 * would read as "nothing is there" and quietly produce wrong work).
 */
export function unavailableExecutor(
  reason: string,
  /** Which unavailability this stands in for. Optional so a caller holding only the
   *  message keeps working — the message is the operator-facing half either way. */
  code: HostChannelUnavailableError["code"] = "not_configured",
): CommandExecutor {
  const refuse = async (): Promise<never> => {
    // Typed for the same reason the construction-time throws are: a refusal at USE time
    // is the same fact as the acquire-time one it replaced, so it has to classify the
    // same way — as a 503 "couldn't reach the host" carrying the remedy, not as an
    // anonymous failure of whatever step happened to ask.
    throw new HostChannelUnavailableError(code, reason);
  };
  return {
    exec: refuse,
    streamExec: refuse,
    writeFile: refuse,
    readFile: refuse,
    exists: refuse,
    mkdir: refuse,
    rm: refuse,
    transferIn: refuse,
    // Nothing was ever opened, so releasing must not be the one call that throws.
    dispose: async () => {},
  };
}

export function createHostExecutor(): CommandExecutor {
  // Explicit opt-out: FAIL rather than degrade. The `!host → LocalExecutor`
  // fallback below is correct for a bare install (LocalExecutor IS the host) but
  // would silently target the CONTAINER's own filesystem in a containerized one —
  // so a disabled host channel must throw, not quietly operate on the wrong box.
  if (hostControlDisabled()) {
    throw new HostChannelUnavailableError(
      "disabled",
      "Host control is disabled on this instance (OPENSHIP_HOST_CONTROL=false). " +
        "Re-run `openship up` without --no-host-control to allow host operations.",
    );
  }
  const host = process.env.OPENSHIP_HOST_SSH_HOST?.trim();
  if (!host) {
    // The hazard the comment above names, for the UNCONFIGURED case rather than the
    // disabled one — and it used to fall through here silently.
    //
    // Containerized with no host channel meant every "this machine" operation ran
    // INSIDE the api container: `docker …` → `docker: not found` (only the socket is
    // mounted, not the CLI), and any host path the daemon reports — a volume's
    // `/var/lib/docker/volumes/<v>/_data` — simply doesn't exist here, so rsync dies
    // with `mkdir … No such file or directory`. Both surface far from the cause,
    // during a migration's data move, looking like Docker or rsync bugs.
    //
    // Fail with the actual remedy instead. Do NOT "fix" this by adding a docker CLI
    // and bind-mounting the host's Docker data-root into the container: that makes
    // the container write daemon-private state directly (unsupported, breaks on
    // non-local volume drivers and rootless installs) to paper over a host channel
    // that simply wasn't provisioned.
    if (runningInContainer()) {
      throw new HostChannelUnavailableError(
        "not_configured",
        "This operation targets the HOST machine, but no host channel is configured " +
          "(OPENSHIP_HOST_SSH_HOST is unset) and Openship is running in a container — " +
          "so it would have run inside the container instead, against the wrong " +
          `filesystem. ${HOST_CHANNEL_NOT_PROVISIONED}`,
      );
    }
    return localExecutor;
  }
  const keyPath = process.env.OPENSHIP_HOST_SSH_KEY?.trim();
  if (!keyPath) {
    // Refused here rather than by SshExecutor's own credential check, which throws a BARE
    // Error — the shape the paragraph below is about. Nothing is denied by refusing early:
    // this function authenticates by key and only by key, so there was no agent or
    // password route left to try. `openship up` writes host and key together; a `.env`
    // edited by hand is where they come apart.
    throw new HostChannelUnavailableError(
      "not_configured",
      "A host channel is configured (OPENSHIP_HOST_SSH_HOST) but OPENSHIP_HOST_SSH_KEY is " +
        `unset, so there is no credential to connect to the host with. ${HOST_CHANNEL_NOT_PROVISIONED}`,
    );
  }
  const read = readHostChannelKey(keyPath);
  if (read.reason) {
    // TYPED like the two throws above, and that is the fix: the demotion that keeps a
    // container deploy alive on a box that can't drive its host keys on this class, so
    // a bare Error here took down every deploy to "This Server" — and every read on
    // that path — over a key the container workload never touches, while
    // `hostChannelHealth` reported the same box as merely degraded (#509).
    //
    // `not_configured` rather than a state of its own: a channel whose key can't be
    // read is not a configured channel and the remedy is identical. The precise state
    // stays on the health `code`, which is what the banner and `openship doctor` read.
    throw new HostChannelUnavailableError(
      "not_configured",
      `${read.reason} ${HOST_CHANNEL_NOT_PROVISIONED}`,
    );
  }
  return new SshExecutor({
    host,
    port: hostChannelPort(),
    username: hostChannelUser(),
    privateKey: read.key,
    // One hop over the docker bridge: it answers at once or it is being filtered.
    // 20s of silence per host operation reads as a hang, not as a failure.
    readyTimeoutMs: 8_000,
    hostChannel: true,
  });
}
