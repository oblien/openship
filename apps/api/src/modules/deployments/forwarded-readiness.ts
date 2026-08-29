/**
 * Readiness probing from a machine that is not this process.
 *
 * A containerized Openship API has its own network namespace, so the published
 * candidate at `127.0.0.1:<hostPort>` means nothing here — that address only resolves
 * to the deployment on the HOST. Two ways to borrow the host's namespace:
 *
 *   1. An SSH `direct-tcpip` channel (`executor.forwardPort`). Preferred: it needs
 *      nothing installed on the host, and we speak the HTTP request ourselves, so a
 *      status-code rule is exact.
 *   2. Running an HTTP client ON the host over the same channel (`executor.exec`).
 *      The fallback, for a channel whose key forbids forwarding.
 *
 * Why (2) exists at all — GH-583. `openship up --compose` provisioned the host key
 * with OpenSSH's `restrict`, which forbids port forwarding; sshd answered every
 * `forwardOut` with SSH_OPEN_ADMINISTRATIVELY_PROHIBITED. The refusal was swallowed
 * into the same `null` a closed port produces, so the probe polled the full timeout
 * and then reported "the app never answered" — on installs where `curl` from the host
 * returned 200 the whole time, and where `openship doctor` correctly said the channel
 * was reachable (it execs fine; only forwarding is denied). The key is fixed for new
 * installs, but an existing one stays that way until `openship up` is re-run, so the
 * refusal must be both survivable and legible HERE.
 *
 * The invariant that follows: a probe that cannot RUN never fails a deploy. It reports
 * `unverifiable` and the caller warns. Destroying a healthy deployment because we
 * couldn't ask is the bug, not the safeguard.
 */

import type { Duplex } from "node:stream";
import { waitForReady, type CommandExecutor } from "@repo/adapters";
import { shellQuote } from "@repo/core";

interface ReadinessOptions {
  path?: string;
  timeoutMs?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  acceptStatusBelow?: number;
}

type PortForwarder = (host: string, port: number) => Promise<Duplex>;

export interface ForwardedReadinessResult {
  ready: boolean;
  /**
   * sshd refused to open the channel as a matter of POLICY rather than because
   * nothing was listening. Carries the description it gave; the poll loop stops
   * immediately, since retrying a refusal for 45s only delays the same answer.
   */
  prohibited?: string;
}

export interface ExecutorReadinessResult {
  ready: boolean;
  /** Which mechanism produced the verdict. */
  via: "forward" | "exec" | "socket";
  /**
   * Set when NO mechanism could answer, so the verdict is UNKNOWN — not "failed".
   * A caller must warn rather than fail on it.
   */
  unverifiable?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * sshd said no as policy, not because the port was closed.
 *
 * `no-port-forwarding` in `authorized_keys` (implied by `restrict`) and
 * `AllowTcpForwarding no` in `sshd_config` both answer reason code 1,
 * ADMINISTRATIVELY_PROHIBITED, described as "administratively prohibited: open
 * failed". Code 3, UNKNOWN_CHANNEL_TYPE, means this server won't do direct-tcpip at
 * all — a different cause with the same consequence, so it counts too.
 *
 * Code 2, CONNECT_FAILED, is deliberately NOT here: it means the host tried and found
 * nothing listening, which is exactly the state a readiness probe polls through.
 * Conflating the two is what turned a permissions problem into "your app crashed".
 */
export function isForwardingProhibited(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const reason = (err as { reason?: unknown }).reason;
  if (reason === 1 || reason === 3) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /administratively prohibited/i.test(message);
}

/** A path we would be splicing into a request line — reject rather than smuggle a header. */
function isProbePathSafe(path: string): boolean {
  return path.startsWith("/") && !/[\r\n]/.test(path);
}

function openForward(
  forward: PortForwarder,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ stream: Duplex | null; error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ stream: null });
    }, timeoutMs);
    timer.unref?.();

    forward(host, port).then(
      (stream) => {
        if (settled) {
          stream.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ stream });
      },
      // The rejection is KEPT, not discarded: it is the only place the difference
      // between "refused to forward" and "nothing listening yet" exists.
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stream: null, error });
      },
    );
  });
}

function probeHttpStream(
  stream: Duplex,
  host: string,
  port: number,
  path: string,
  timeoutMs: number,
  acceptStatusBelow: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();

    stream.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const lineEnd = received.indexOf("\r\n");
      if (lineEnd < 0) {
        if (received.length > 8_192) done(false);
        return;
      }
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(received.slice(0, lineEnd));
      const status = match ? Number(match[1]) : 0;
      done(status > 0 && status < acceptStatusBelow);
    });
    stream.once("error", () => done(false));
    stream.once("end", () => done(false));

    if (!isProbePathSafe(path)) {
      done(false);
      return;
    }
    stream.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
  });
}

/** Poll readiness from the machine represented by an SSH direct-tcpip channel. */
export async function waitForForwardedReady(
  forward: PortForwarder,
  host: string,
  port: number,
  opts: ReadinessOptions = {},
): Promise<ForwardedReadinessResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ready: false };
    const attempt = await openForward(forward, host, port, Math.min(probeTimeoutMs, remaining));
    if (attempt.error && isForwardingProhibited(attempt.error)) {
      const detail = (attempt.error as { message?: unknown }).message;
      return {
        ready: false,
        prohibited: typeof detail === "string" ? detail : "channel open refused by the server",
      };
    }
    if (attempt.stream) {
      if (!opts.path) {
        attempt.stream.destroy();
        return { ready: true };
      }
      if (
        await probeHttpStream(
          attempt.stream,
          host,
          port,
          opts.path,
          Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())),
          opts.acceptStatusBelow ?? 500,
        )
      ) {
        return { ready: true };
      }
    }
    const waitMs = Math.min(intervalMs, deadline - Date.now());
    if (waitMs <= 0) return { ready: false };
    await delay(waitMs);
  }
}

/** Marker the host-side probe prints when the host has no HTTP client to probe with. */
const PROBE_NO_CLIENT = "OPENSHIP_PROBE_NO_CLIENT";
/** Marker prefix carrying curl's status code and exit code back. */
const PROBE_RESULT = "OPENSHIP_PROBE";

/**
 * One host-side probe of `http://host:port<path>`, as a shell command.
 *
 * PURE and exported for tests, because it is a command built from a project-supplied
 * path and run on the host: every interpolation is `shellQuote`d, and the path is
 * validated by the caller before it reaches here.
 *
 * Always exits 0 and reports through stdout markers instead: `executor.exec` rejects on a
 * non-zero exit, and curl exits non-zero for outcomes we need to READ (52 "empty reply"
 * still proves the port accepted a connection), so letting the exit code escape would
 * collapse every one of them into a single thrown error.
 *
 * `%{num_connects}` rather than curl's exit code is what makes the TCP verdict exact.
 * Reading "not exit 7" as "it connected" is wrong for exit 28: a timeout that happened
 * BEFORE the handshake (a dropped SYN on a bridge IP — a target
 * `resolveReadinessTarget` really can pick) is indistinguishable from one after it, so a
 * dead workload would have been reported healthy. `num_connects` counts completed
 * connections, so it answers the actual question with no heuristic.
 */
export function buildHostProbeCommand(args: {
  host: string;
  port: number;
  path?: string;
  timeoutSeconds: number;
}): string {
  const url = shellQuote(`http://${args.host}:${args.port}${args.path ?? "/"}`);
  const maxTime = shellQuote(String(Math.max(1, Math.round(args.timeoutSeconds))));
  return (
    `command -v curl >/dev/null 2>&1 || { echo ${shellQuote(PROBE_NO_CLIENT)}; exit 0; }; ` +
    `out=$(curl -sS -o /dev/null -w '%{http_code} %{num_connects}' ` +
    `--max-time ${maxTime} ${url} 2>/dev/null); ` +
    `echo "${PROBE_RESULT} $out"; exit 0`
  );
}

export type HostProbeOutput =
  | { kind: "no-client" }
  /** `connects` > 0 means a TCP handshake completed, whatever the HTTP outcome was. */
  | { kind: "result"; status: number; connects: number }
  | { kind: "unparsed" };

/** PURE. Read {@link buildHostProbeCommand}'s markers back out of stdout. */
export function parseHostProbeOutput(stdout: string): HostProbeOutput {
  if (stdout.includes(PROBE_NO_CLIENT)) return { kind: "no-client" };
  const match = new RegExp(`${PROBE_RESULT} (\\d+) (\\d+)`).exec(stdout);
  if (!match) return { kind: "unparsed" };
  return { kind: "result", status: Number(match[1]), connects: Number(match[2]) };
}

/**
 * Poll readiness by running an HTTP client ON the host over `executor.exec`.
 *
 * Semantics match the forwarded probe: with a `path`, ready means an HTTP status below
 * `acceptStatusBelow`; without one, ready means the TCP handshake completed — which
 * `%{num_connects}` reports directly, so an app that accepts a connection and then
 * speaks something other than HTTP still passes a TCP-only gate, exactly as it does
 * over a forwarded channel.
 */
async function waitForExecReady(
  executor: CommandExecutor,
  host: string,
  port: number,
  opts: ReadinessOptions,
): Promise<{ ready: boolean; unavailable?: string }> {
  if (opts.path && !isProbePathSafe(opts.path)) {
    return { ready: false };
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2_500;
  const acceptStatusBelow = opts.acceptStatusBelow ?? 500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ready: false };
    const probeSeconds = Math.max(1, Math.round(Math.min(probeTimeoutMs, remaining) / 1000));
    const command = buildHostProbeCommand({
      host,
      port,
      path: opts.path,
      timeoutSeconds: probeSeconds,
    });

    let stdout: string;
    try {
      stdout = await executor.exec(command, { timeout: (probeSeconds + 5) * 1000 });
    } catch (err) {
      // The channel itself failed, so there is no verdict to give. Reported as
      // unavailable rather than "not ready" — see the module note.
      const detail = err instanceof Error ? err.message : String(err);
      return { ready: false, unavailable: `probing from the host failed: ${detail}` };
    }

    const parsed = parseHostProbeOutput(stdout);
    if (parsed.kind === "no-client") {
      return { ready: false, unavailable: "the host has no `curl` to probe with" };
    }
    if (parsed.kind === "unparsed") {
      return { ready: false, unavailable: "the host probe returned nothing we could read" };
    }
    const ready = opts.path
      ? parsed.status > 0 && parsed.status < acceptStatusBelow
      : parsed.connects > 0;
    if (ready) return { ready: true };

    const waitMs = Math.min(intervalMs, deadline - Date.now());
    if (waitMs <= 0) return { ready: false };
    await delay(waitMs);
  }
}

/**
 * Probe `host:port` from the machine `executor` represents.
 *
 * Forwarding first; a channel that refuses it falls back to a host-side HTTP client
 * rather than reporting the app dead. A LocalExecutor (non-containerized install) has
 * no `forwardPort` and needs neither hop — its own sockets already sit on the host.
 */
export async function waitForReadyFromExecutor(
  executor: CommandExecutor,
  host: string,
  port: number,
  opts: ReadinessOptions = {},
): Promise<ExecutorReadinessResult> {
  if (!executor.forwardPort) {
    return { ready: await waitForReady(host, port, opts), via: "socket" };
  }

  const startedAt = Date.now();
  const forwarded = await waitForForwardedReady(
    executor.forwardPort.bind(executor),
    host,
    port,
    opts,
  );
  if (!forwarded.prohibited) return { ready: forwarded.ready, via: "forward" };

  // The fallback inherits what is LEFT of the budget, not a fresh copy of it: the caller
  // told the operator "waiting up to Ns" and then reports against that number. A refusal
  // is detected on the first attempt, so this is normally the whole window — but it must
  // never be two of them.
  const viaExec = await waitForExecReady(executor, host, port, {
    ...opts,
    timeoutMs: Math.max(1_000, (opts.timeoutMs ?? 30_000) - (Date.now() - startedAt)),
  });
  return {
    ready: viaExec.ready,
    via: "exec",
    ...(viaExec.unavailable
      ? {
          unverifiable:
            `this host's control channel refuses port forwarding (${forwarded.prohibited}), ` +
            `and ${viaExec.unavailable}`,
        }
      : {}),
  };
}
