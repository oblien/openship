import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMailRunCommand,
  ensureContainerMail,
  resolveMailImage,
  setDefaultMailImage,
} from "./ensure-container-mail";
import { setManagedImagesFromSource } from "../managed-image";

afterEach(() => {
  setDefaultMailImage(undefined);
  setManagedImagesFromSource("mail", false);
});

/**
 * The one container-state probe every path here goes through (`containerState`):
 * run state AND created-from image in a single `docker inspect`, tab-separated.
 * Stubs match on the template so a change to the probe shape fails loudly instead
 * of silently reading as "no container" (which is how these stubs first drifted).
 */
const STATE_PROBE = "{{.State.Running}}";
const stateLine = (image: string, running = true) => `${running}\t${image}\n`;

describe("buildMailRunCommand", () => {
  it("runs host-networked with NET_ADMIN, restart, env-file, and the load-bearing mounts", () => {
    const cmd = buildMailRunCommand("openship-mail", "ghcr.io/x/openship-mail:1");
    expect(cmd).toContain("--network host");
    expect(cmd).toContain("--cap-add NET_ADMIN");
    expect(cmd).toContain("--restart unless-stopped");
    expect(cmd).toContain("--env-file");
    // The Postfix queue must be a bind mount or a recreate drops in-flight mail.
    expect(cmd).toContain("/var/spool/postfix");
    // The cert store is shared with the edge and mounted read-only.
    expect(cmd).toContain("/etc/letsencrypt:ro,z");
    // Image is the final, shell-quoted token.
    expect(cmd.endsWith("'ghcr.io/x/openship-mail:1'")).toBe(true);
  });
});

describe("resolveMailImage", () => {
  it("prefers an explicit ref, else the injected default", () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    expect(resolveMailImage("explicit:1")).toBe("explicit:1");
    expect(resolveMailImage()).toBe("ghcr.io/x/openship-mail:pinned");
  });
});

describe("ensureContainerMail idempotency", () => {
  it("returns updated:false without pulling when already on the pinned image", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const streamExec = vi.fn(async () => ({ code: 0, output: "" }));
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes(STATE_PROBE)) return stateLine("ghcr.io/x/openship-mail:pinned");
      return "";
    });
    const executor = { exec, streamExec } as never;

    const res = await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    });

    expect(res.updated).toBe(false);
    expect(res.image).toBe("ghcr.io/x/openship-mail:pinned");
    // No pull and no docker run — the running container already matches.
    expect(streamExec).not.toHaveBeenCalled();
  });
});

// A /proc/net/tcp dump with LISTEN (state 0A) sockets for the DB (5432 = 0x1538),
// SMTP (25 = 0x19) and IMAPS (993 = 0x3E1) ports, so waitForPortListening resolves
// on the first poll and the bring-up doesn't spin until its (long) deadline.
const PROC_LISTENING = [
  "  sl  local_address rem_address   st ...",
  "  0: 00000000:1538 00000000:0000 0A 00000000:00000000",
  "  1: 00000000:0019 00000000:0000 0A 00000000:00000000",
  "  2: 00000000:03E1 00000000:0000 0A 00000000:00000000",
].join("\n");

/**
 * A first-boot executor: no container running, docker available, ports reported
 * listening, and the image-presence probe reports whatever `imagePresent` says.
 * `streamExec` and the writes succeed so the bring-up runs end to end.
 */
function firstBootExecutor(opts: { imagePresent: boolean }) {
  const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
  const exec = vi.fn(async (cmd: string) => {
    // No engine on the box yet — the state probe finds nothing.
    if (cmd.includes(STATE_PROBE)) return "";
    // Docker is available.
    if (cmd.includes("docker version")) return "27.0.0\n";
    // Image presence probe (docker image inspect -f '{{.Id}}').
    if (cmd.includes("docker image inspect")) return opts.imagePresent ? "sha256:abc\n" : "";
    // Port-listening probe reads /proc/net/tcp.
    if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
    return "";
  });
  const writeFile = vi.fn(async () => {});
  return { executor: { exec, streamExec, writeFile } as never, exec, streamExec };
}

// Create-path image acquisition: pull only when the image ISN'T already on the box.
// In dev, `deliverManagedImage` builds the content-derived `…-dev.<hash>` engine tag
// on the control plane and ships it here first, so bring-up finds it present and
// skips the pull (an unpublished tag — a pull would 404). In prod the tag is absent,
// so it pulls `:APP_VERSION`.
describe("ensureContainerMail image acquisition gate", () => {
  it("skips the registry pull when the image is already present locally (delivered dev tag)", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec } = firstBootExecutor({ imagePresent: true });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {}); // verifyEngine may fail on the stub; we only assert the pull

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(false);
  });

  it("pulls when the image is absent locally (prod)", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const { executor, streamExec } = firstBootExecutor({ imagePresent: false });

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {});

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(true);
  });

  // From-source (dev) backstop: an absent unpublished tag means the control-plane
  // build/ship didn't complete. Throw a clear error rather than a 404-ing pull.
  it("throws instead of pulling an absent image when managed images are from source", async () => {
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    setManagedImagesFromSource("mail", true);
    const { executor, streamExec } = firstBootExecutor({ imagePresent: false });

    await expect(
      ensureContainerMail(executor, { domain: "example.com", secrets: {}, onLog: () => {} }),
    ).rejects.toThrow(/from-source mail engine image .* isn't on this server/);

    const pulled = streamExec.mock.calls.some(([cmd]) => String(cmd).startsWith("docker pull"));
    expect(pulled).toBe(false);
  });
});

describe("ensureContainerMail swap", () => {
  it("swaps a running engine onto a new tag with no pull when that tag is already present", async () => {
    // The delivered dev tag differs from the running engine's tag (the source hash
    // moved), so it's stale — but it's already on the box, so the swap runs no pull.
    setDefaultMailImage("ghcr.io/x/openship-mail:pinned");
    const streamExec = vi.fn(async (_cmd: string) => ({ code: 0, output: "" }));
    const exec = vi.fn(async (cmd: string) => {
      // Engine is running on an OLDER tag → stale vs the pinned ref.
      if (cmd.includes(STATE_PROBE)) return stateLine("ghcr.io/x/openship-mail:old");
      // The pinned tag is already present locally (deliver shipped it) → no pull.
      if (cmd.includes("docker image inspect")) return "sha256:present\n";
      if (cmd.includes("/proc/net/tcp")) return PROC_LISTENING;
      return "";
    });
    const executor = { exec, streamExec, writeFile: vi.fn(async () => {}) } as never;

    await ensureContainerMail(executor, {
      domain: "example.com",
      secrets: {},
      onLog: () => {},
    }).catch(() => {});

    const cmds = streamExec.mock.calls.map(([cmd]) => String(cmd));
    // Swapped in place — a new engine `docker run`, and no pull (tag already present).
    expect(cmds.some((c) => c.includes("docker run") && c.includes("--network host"))).toBe(true);
    expect(cmds.some((c) => c.startsWith("docker pull"))).toBe(false);
  });
});
