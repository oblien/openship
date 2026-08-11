import { describe, expect, it, vi } from "vitest";
import { installOpenResty, installCertbot } from "../src/system/installer";
import type { CommandExecutor, SystemLog } from "../src/types";

/**
 * The edge container IS OpenResty and holds :80/:443 in host network mode, so the
 * host package must never be installed alongside it (#288).
 *
 * This isn't "redundant work" — Debian's postinst STARTS openresty.service, the
 * bind fails with "Address already in use", the postinst exits non-zero, and dpkg
 * is left half-configured. That breaks EVERY later apt operation on the box, which
 * is why the reporter's mail-server setup died mid-install.
 *
 * `installCertbot` already had this guard; `installOpenResty` did not.
 */

const noLog = (_l: SystemLog) => {};

/** Executor that reports an openship-edge container and answers execs inside it. */
const withEdge = (inContainer: Record<string, string>) => {
  const seen: string[] = [];
  const exec = {
    exec: vi.fn(async (cmd: string) => {
      seen.push(cmd);
      // resolveOurEdgeContainer probes for our edge by name.
      if (cmd.includes("docker ps") && cmd.includes("openship-edge")) return "openship-edge";
      for (const [needle, out] of Object.entries(inContainer)) {
        if (cmd.includes(needle)) return out;
      }
      return "";
    }),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
  } as unknown as CommandExecutor;
  return { exec, seen };
};

describe("installOpenResty with a container edge present", () => {
  it("does NOT run the package manager — the edge already provides OpenResty", async () => {
    const { exec, seen } = withEdge({
      "openresty -v": "nginx version: openresty/1.27.1.1",
    });

    const res = await installOpenResty(exec, noLog);

    expect(res.success).toBe(true);
    expect(res.component).toBe("openresty");
    // The whole point: nothing that could trip the postinst.
    const apt = seen.filter((c) => /apt-get|apt |dnf|yum|apk add|zypper/.test(c));
    expect(apt).toEqual([]);
  });

  it("never touches systemctl for a host openresty service that shouldn't exist", async () => {
    const { exec, seen } = withEdge({ "openresty -v": "openresty/1.27.1.1" });
    await installOpenResty(exec, noLog);
    expect(seen.filter((c) => c.includes("systemctl"))).toEqual([]);
  });

  it("reports the version the CONTAINER provides", async () => {
    const { exec } = withEdge({ "openresty -v": "nginx version: openresty/1.25.3.2" });
    const res = await installOpenResty(exec, noLog);
    expect(res.version).toContain("1.25.3.2");
  });

  it("falls through to a real install when the container has no openresty", async () => {
    // A container that answers nothing for `openresty -v` isn't our edge providing
    // it, so the guard must not swallow a genuinely needed install.
    const { exec, seen } = withEdge({});
    await installOpenResty(exec, noLog).catch(() => undefined);
    // It got past the guard (privilege prep / catalog work happened).
    expect(seen.some((c) => !c.includes("docker ps"))).toBe(true);
  });

  it("matches the guard installCertbot already had", async () => {
    // Same box, same shape — the two components must agree, since they're both
    // baked into the edge image.
    const { exec, seen } = withEdge({
      "certbot --version": "certbot 2.9.0",
      "openresty -v": "openresty/1.27.1.1",
    });

    const certbot = await installCertbot(exec, noLog);
    const openresty = await installOpenResty(exec, noLog);

    expect(certbot.success).toBe(true);
    expect(openresty.success).toBe(true);
    expect(seen.filter((c) => /apt-get|dnf|yum|apk add/.test(c))).toEqual([]);
  });
});
