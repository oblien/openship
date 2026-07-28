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
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
    // It reaches SshExecutor's own credential validation, which is proof it got PAST
    // the fallback — the assertion that matters is that it never degrades to running
    // in the container. (A real install also has OPENSHIP_HOST_SSH_KEY.)
    let err: unknown;
    try {
      createHostExecutor();
    } catch (e) {
      err = e;
    }
    expect(String(err ?? "")).not.toMatch(/no host channel is configured/i);
    expect(String(err ?? "")).toMatch(/SSH requires one of privateKey/i);
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
});
