/**
 * `createHostExecutor` must never silently target the CONTAINER when the caller
 * asked for the HOST.
 *
 * This is the root cause behind two failures that look like Docker/rsync bugs during
 * a migration whose source or target is "this server":
 *   • `docker: not found` (exit 127) — only the socket is mounted, not the CLI
 *   • `rsync: mkdir … No such file or directory` — the daemon reports a HOST path
 *     (`/var/lib/docker/volumes/<v>/_data`) that doesn't exist inside the container
 * Both come from the same place: no host channel + containerized → LocalExecutor.
 *
 * The refusals also have to be CLASSIFIED. `HostChannelUnavailableError` is the one signal
 * that demotes "this box can't drive its host" from a resolve-time throw to a use-time
 * refusal (deployment-runtime's `acquireLocalHostExecutor`), maps a host op to a 503
 * instead of a 400, and makes the server check diagnose the channel. An untyped throw
 * skips all three, so an unreadable key took down every deploy to "This Server" — and
 * every read on that path — over a credential the container workload never touches, while
 * `hostChannelHealth` reported the same box as merely degraded (#509).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TcpProbeResult } from "./reachability";

const net = vi.hoisted(() => ({
  probe: vi.fn(async (): Promise<TcpProbeResult> => ({ ok: true })),
}));

vi.mock("./reachability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reachability")>()),
  probeTcpDetailed: net.probe,
}));

const ENV_KEYS = [
  "OPENSHIP_HOST_CONTROL",
  "OPENSHIP_HOST_SSH_HOST",
  "OPENSHIP_HOST_SSH_KEY",
  "OPENSHIP_HOST_SSH_PORT",
  "OPENSHIP_HOST_SSH_USER",
  "OPENSHIP_IN_CONTAINER",
] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  clearEnv();
  vi.resetModules();
});

async function load() {
  vi.resetModules();
  return import("./executor");
}

/** A provisioned channel pointed at `keyPath`, exactly as `openship up` writes it. */
function channelWithKey(keyPath: string) {
  clearEnv();
  process.env.OPENSHIP_IN_CONTAINER = "true";
  process.env.OPENSHIP_HOST_SSH_HOST = "host.docker.internal";
  process.env.OPENSHIP_HOST_SSH_KEY = keyPath;
}

const scratch = () => mkdtempSync(join(tmpdir(), "openship-host-key-"));

async function throwFrom(): Promise<unknown> {
  const { createHostExecutor } = await load();
  try {
    createHostExecutor();
  } catch (err) {
    return err;
  }
  return expect.unreachable("createHostExecutor should have refused");
}

describe("createHostExecutor", () => {
  it("bare install (not containerized, no host channel) → LocalExecutor IS the host", async () => {
    clearEnv();
    const { createHostExecutor } = await load();
    // On a dev machine /.dockerenv is absent, so this is the bare path.
    expect(() => createHostExecutor()).not.toThrow();
  });

  it("containerized with NO host channel → throws instead of running in the container", async () => {
    clearEnv();
    process.env.OPENSHIP_IN_CONTAINER = "true";
    const { createHostExecutor } = await load();
    expect(() => createHostExecutor()).toThrow(/no host channel is configured/i);
  });

  it("the error names the remedy, not the symptom", async () => {
    clearEnv();
    process.env.OPENSHIP_IN_CONTAINER = "true";
    const { createHostExecutor } = await load();
    // Whoever hits this is staring at a failed migration; the message has to point
    // at the missing channel, not leave them debugging docker or rsync.
    expect(() => createHostExecutor()).toThrow(/openship up/);
  });

  it("containerized WITH a host channel → takes the SSH path, not the container", async () => {
    clearEnv();
    process.env.OPENSHIP_IN_CONTAINER = "true";
    process.env.OPENSHIP_HOST_SSH_HOST = "host.docker.internal";
    const { createHostExecutor } = await load();
    const { isHostChannelUnavailableError } = await import("./errors");
    // A host with no key is the credential-skew case, and what it must NOT do is degrade
    // to running in the container. It used to reach SshExecutor's own credential check,
    // which throws a bare Error — untyped, so the demotion that keeps a container deploy
    // alive rethrew it and every deploy to "This Server" died on it. The refusal is now
    // the same class as the others. (A real install also has OPENSHIP_HOST_SSH_KEY.)
    let err: unknown;
    try {
      createHostExecutor();
    } catch (e) {
      err = e;
    }
    expect(isHostChannelUnavailableError(err)).toBe(true);
    expect(String(err ?? "")).not.toMatch(/no host channel is configured/i);
    expect(String(err ?? "")).toMatch(/OPENSHIP_HOST_SSH_KEY is unset/i);
  });

  it("explicitly disabled host control still throws its own error", async () => {
    clearEnv();
    process.env.OPENSHIP_HOST_CONTROL = "false";
    const { createHostExecutor } = await load();
    expect(() => createHostExecutor()).toThrow(/Host control is disabled/i);
  });

  it("disabled beats configured — an operator opt-out is not overridable by env", async () => {
    clearEnv();
    process.env.OPENSHIP_HOST_CONTROL = "false";
    process.env.OPENSHIP_HOST_SSH_HOST = "host.docker.internal";
    const { createHostExecutor } = await load();
    expect(() => createHostExecutor()).toThrow(/Host control is disabled/i);
  });

  /**
   * Both throws are TYPED, because one caller has to tell "this box cannot drive its
   * host" apart from "the host channel is broken": resolving a local server row for a
   * deploy that only needs the Docker socket (#490).
   */
  it("tags a disabled channel so callers can distinguish it from a real fault", async () => {
    clearEnv();
    process.env.OPENSHIP_HOST_CONTROL = "false";
    const { createHostExecutor } = await load();
    const { isHostChannelUnavailableError } = await import("./errors");
    try {
      createHostExecutor();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isHostChannelUnavailableError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("disabled");
    }
  });

  it("tags an unprovisioned channel with its own code", async () => {
    clearEnv();
    process.env.OPENSHIP_IN_CONTAINER = "true";
    const { createHostExecutor } = await load();
    const { isHostChannelUnavailableError } = await import("./errors");
    try {
      createHostExecutor();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isHostChannelUnavailableError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("not_configured");
    }
  });
});

/** A channel whose KEY can't be read must fail like the other two unavailable states,
 *  not like a broken box — see this file's header for what turns on the class. */
describe("createHostExecutor with an unusable host key", () => {
  it("tags a missing key file so the local-row demotion recognises it", async () => {
    const keyPath = join(scratch(), "host_ed25519");
    channelWithKey(keyPath);
    const err = await throwFrom();
    const { isHostChannelUnavailableError } = await import("./errors");
    // The assertion the bug was: an untyped throw here reaches
    // `if (!isHostChannelUnavailableError(err)) throw err` and fails the deploy.
    expect(isHostChannelUnavailableError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("not_configured");
  });

  it("tags a key path that compose turned into a directory (ENOENT bind source)", async () => {
    // What a missing bind SOURCE produces: docker creates a directory at the target, so
    // the read fails with EISDIR rather than ENOENT. Same state, same handling.
    const dir = join(scratch(), "openship_host_key");
    mkdirSync(dir);
    channelWithKey(dir);
    const err = await throwFrom();
    const { isHostChannelUnavailableError } = await import("./errors");
    expect(isHostChannelUnavailableError(err)).toBe(true);
  });

  it("refuses an EMPTY key instead of handing ssh2 no credentials", async () => {
    // The shipped compose mounts /dev/null when no key was provisioned. Reading that
    // SUCCEEDS, so this used to fall through to SshExecutor and die with "SSH requires
    // one of privateKey/password/agent" — untyped, and naming neither the channel nor
    // the fix.
    const keyPath = join(scratch(), "host_ed25519");
    writeFileSync(keyPath, "");
    channelWithKey(keyPath);
    const err = await throwFrom();
    const { isHostChannelUnavailableError } = await import("./errors");
    expect(isHostChannelUnavailableError(err)).toBe(true);
    expect(String(err)).not.toMatch(/SSH requires one of privateKey/i);
    expect(String(err)).toMatch(/is empty/);
  });

  it("names the key path and both commands, because it is read in a failed deploy log", async () => {
    const keyPath = join(scratch(), "host_ed25519");
    channelWithKey(keyPath);
    const message = (await throwFrom()) as Error;
    expect(message.message).toContain(keyPath);
    expect(message.message).toMatch(/openship up/);
    // The verification half: the repair runs on the host and the fault is observed in a
    // container, so "did it work" is a separate question (@repo/core's #509 copy).
    expect(message.message).toMatch(/openship doctor/);
  });

  it("still builds the SSH executor when the key reads fine", async () => {
    const keyPath = join(scratch(), "host_ed25519");
    writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n");
    channelWithKey(keyPath);
    const { createHostExecutor } = await load();
    expect(() => createHostExecutor()).not.toThrow();
  });

  it("says the same thing on the health path — one box, one verdict", async () => {
    const keyPath = join(scratch(), "host_ed25519");
    writeFileSync(keyPath, "");
    channelWithKey(keyPath);
    const { hostChannelHealth } = await load();
    net.probe.mockClear();
    const health = await hostChannelHealth(100);
    // An empty key is not a dial problem: decided before the probe, and reported as the
    // state the banner and `openship doctor` already have copy for.
    expect(health).toMatchObject({ ok: false, code: "key_unreadable" });
    expect(net.probe).not.toHaveBeenCalled();
    expect(health.hint).toContain(keyPath);
    expect(health.hint).toBe(((await throwFrom()) as Error).message);
  });
});

/**
 * The remedy has to match the fault. Every failed dial used to be answered with a ufw
 * rule, so an operator whose sshd was bound to loopback, or whose rootless Docker
 * provides no host gateway at all (#482), was sent to edit a firewall that was never
 * filtering anything — and then had no reason to trust the next thing we told them.
 */
describe("hostChannelHealth diagnosis", () => {
  async function healthFor(probe: TcpProbeResult) {
    clearEnv();
    process.env.OPENSHIP_IN_CONTAINER = "true";
    process.env.OPENSHIP_HOST_SSH_HOST = "host.docker.internal";
    net.probe.mockResolvedValueOnce(probe);
    const { hostChannelHealth } = await load();
    return hostChannelHealth(100);
  }

  it("a dropped packet is the one case that gets a firewall rule", async () => {
    const h = await healthFor({ ok: false, reason: "timeout" });
    expect(h).toMatchObject({ ok: false, code: "unreachable", cause: "timeout" });
    // Both syntaxes, each behind a `#` label: from inside the container there is no
    // host package list to read, so guessing ufw would hand half of all hosts a
    // command that doesn't exist. Scoped to the bridge either way.
    expect(h.rule).toMatch(/^# ufw:\nsudo ufw allow from \S+ to any port 22 proto tcp$/m);
    expect(h.rule).toMatch(/^# firewalld:\nsudo firewall-cmd --permanent --add-rich-rule=/m);
    expect(h.rule).toContain("sudo firewall-cmd --reload");
    // Name the asymmetry, or "but my other ports work" reads as a contradiction.
    expect(h.hint).toMatch(/INPUT chain/);
  });

  it("a refusal points at sshd, and offers no firewall rule", async () => {
    const h = await healthFor({ ok: false, reason: "refused", code: "ECONNREFUSED" });
    expect(h).toMatchObject({ ok: false, cause: "refused" });
    expect(h.rule).toBeUndefined();
    expect(h.hint).toMatch(/ListenAddress/);
    expect(h.hint).toMatch(/ECONNREFUSED/);
  });

  it("an unresolved host names extra_hosts and rootless Docker, not a firewall", async () => {
    const h = await healthFor({ ok: false, reason: "unresolved", code: "ENOTFOUND" });
    expect(h).toMatchObject({ ok: false, cause: "unresolved" });
    expect(h.rule).toBeUndefined();
    expect(h.hint).toMatch(/host-gateway/);
    expect(h.hint).toMatch(/rootless/i);
  });

  it("no route says so rather than guessing at a packet filter", async () => {
    const h = await healthFor({ ok: false, reason: "no_route", code: "EHOSTUNREACH" });
    expect(h).toMatchObject({ ok: false, cause: "no_route" });
    expect(h.rule).toBeUndefined();
    expect(h.hint).toMatch(/OPENSHIP_HOST_SSH_HOST/);
  });

  it("an unclassified failure reports what it was told and prescribes nothing", async () => {
    const h = await healthFor({ ok: false, reason: "error", code: "EPERM", message: "denied" });
    expect(h).toMatchObject({ ok: false, cause: "error" });
    expect(h.rule).toBeUndefined();
    expect(h.hint).toMatch(/EPERM.*denied/);
  });

  it("a working channel carries no cause and no remedy", async () => {
    const h = await healthFor({ ok: true });
    expect(h).toMatchObject({ ok: true, code: "ok", target: "root@host.docker.internal:22" });
    expect(h.cause).toBeUndefined();
    expect(h.hint).toBeUndefined();
  });

  it("decides by env before dialing, so a bare install costs no probe", async () => {
    clearEnv();
    const { hostChannelHealth } = await load();
    net.probe.mockClear();
    expect(await hostChannelHealth(100)).toMatchObject({ ok: true, code: "not_applicable" });
    expect(net.probe).not.toHaveBeenCalled();
  });
});

describe("unavailableExecutor", () => {
  const REASON = "Host control is disabled on this instance.";

  it("refuses every operation with the reason, rather than answering wrongly", async () => {
    const { unavailableExecutor } = await load();
    const exec = unavailableExecutor(REASON);
    // `exists` is the one that matters most: a `false` here reads as "the file isn't
    // there" and quietly produces wrong work (a reclaimed release, a free port).
    await expect(exec.exists("/opt/openship/static/x")).rejects.toThrow(REASON);
    await expect(exec.exec("ls")).rejects.toThrow(REASON);
    await expect(exec.readFile("/etc/hosts")).rejects.toThrow(REASON);
    await expect(exec.writeFile("/tmp/x", "y")).rejects.toThrow(REASON);
    await expect(exec.mkdir("/tmp/x")).rejects.toThrow(REASON);
    await expect(exec.rm("/tmp/x")).rejects.toThrow(REASON);
    await expect(exec.transferIn("/tmp/a", "/tmp/b")).rejects.toThrow(REASON);
    await expect(exec.streamExec("ls", () => {})).rejects.toThrow(REASON);
  });

  it("disposes cleanly — nothing was opened, so releasing must not be what fails", async () => {
    const { unavailableExecutor } = await load();
    await expect(unavailableExecutor(REASON).dispose()).resolves.toBeUndefined();
  });

  // The test above covers that every method refuses and carries the reason; the claim
  // here is the one the demotion depends on — the refusal is CLASSIFIED, and carries the
  // unavailability it stands in for rather than flattening every cause into one.
  it("refuses with a CLASSIFIED error, so the refusal reads as a host-channel fault", async () => {
    const { unavailableExecutor } = await load();
    const { isHostChannelUnavailableError } = await import("./errors");
    const exec = unavailableExecutor(REASON, "disabled");
    const err = await exec.exists("/etc/letsencrypt/live/x/fullchain.pem").catch((e) => e);
    expect(isHostChannelUnavailableError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("disabled");
    expect((err as Error).message).toBe(REASON);
    for (const op of [
      exec.exec("ls"),
      exec.readFile("/etc/hosts"),
      exec.writeFile("/tmp/x", "y"),
      exec.mkdir("/tmp/x"),
      exec.rm("/tmp/x"),
      exec.transferIn("/tmp/a", "/tmp/b"),
      exec.streamExec("ls", () => {}),
    ]) {
      await expect(op).rejects.toSatisfy(isHostChannelUnavailableError);
    }
  });
});
