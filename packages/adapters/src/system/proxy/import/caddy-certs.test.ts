import { describe, expect, it, vi } from "vitest";
import { caddyStoreCert } from "./caddy-certs";
import type { CommandExecutor } from "../../../types";

// Caddy auto-provisions HTTPS, so the usual Caddyfile declares no cert paths and
// the config parsers can't surface one. Its own store is the only place the cert
// exists — without reading it, every Caddy box re-issues through ACME on migrate
// even though a valid cert is sitting on disk.

const LE_DIR = "acme-v02.api.letsencrypt.org-directory";

/**
 * Executor over a fake filesystem. `ls -1 <glob>` is answered by matching the glob
 * against the file keys, so the test exercises the real glob shape the code emits.
 */
function exec(files: Record<string, string>, containerFiles?: Record<string, string>): CommandExecutor {
  const listing = (cmd: string, from: Record<string, string>): string => {
    const m = cmd.match(/ls -1 (\S+)/);
    if (!m) return "";
    const rx = new RegExp(`^${m[1].replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
    return Object.keys(from).filter((p) => rx.test(p)).join("\n");
  };
  return {
    readFile: vi.fn(async (p: string) => {
      if (files[p] === undefined) throw new Error("enoent");
      return files[p];
    }),
    exec: vi.fn(async (cmd: string) => {
      if (cmd.startsWith("docker exec")) {
        if (cmd.includes("ls -1")) return listing(cmd, containerFiles ?? {});
        const hit = Object.entries(containerFiles ?? {}).find(([p]) => cmd.includes(p));
        return hit ? hit[1] : "";
      }
      return listing(cmd, files);
    }),
  } as unknown as CommandExecutor;
}

describe("caddyStoreCert", () => {
  it("finds the pair under the systemd data root, whatever CA directory it's in", async () => {
    const base = `/var/lib/caddy/.local/share/caddy/certificates/${LE_DIR}/a.com`;
    const e = exec({ [`${base}/a.com.crt`]: "CERT", [`${base}/a.com.key`]: "KEY" });
    const got = await caddyStoreCert(e, "a.com");
    expect(got).toMatchObject({ certPem: "CERT", keyPem: "KEY" });
    expect(got?.source).toContain(`${base}/a.com.crt`);
  });

  it("finds the pair under the root-user data root", async () => {
    const base = `/root/.local/share/caddy/certificates/${LE_DIR}/a.com`;
    const e = exec({ [`${base}/a.com.crt`]: "CERT", [`${base}/a.com.key`]: "KEY" });
    expect(await caddyStoreCert(e, "a.com")).toMatchObject({ certPem: "CERT", keyPem: "KEY" });
  });

  it("resolves a host covered by a WILDCARD cert (certmagic's wildcard_ dir)", async () => {
    // certmagic sanitizes `*.a.com` to `wildcard_.a.com` on disk.
    const base = `/var/lib/caddy/.local/share/caddy/certificates/${LE_DIR}/wildcard_.a.com`;
    const e = exec({
      [`${base}/wildcard_.a.com.crt`]: "WCERT",
      [`${base}/wildcard_.a.com.key`]: "WKEY",
    });
    expect(await caddyStoreCert(e, "app.a.com")).toMatchObject({
      certPem: "WCERT",
      keyPem: "WKEY",
    });
  });

  it("prefers the exact-host cert over the wildcard when both exist", async () => {
    const root = `/var/lib/caddy/.local/share/caddy/certificates/${LE_DIR}`;
    const e = exec({
      [`${root}/app.a.com/app.a.com.crt`]: "EXACT",
      [`${root}/app.a.com/app.a.com.key`]: "EXACTKEY",
      [`${root}/wildcard_.a.com/wildcard_.a.com.crt`]: "WCERT",
      [`${root}/wildcard_.a.com/wildcard_.a.com.key`]: "WKEY",
    });
    expect((await caddyStoreCert(e, "app.a.com"))?.certPem).toBe("EXACT");
  });

  it("reads the store INSIDE the container when the host can't see it", async () => {
    // The official image sets XDG_DATA_HOME=/data, and with a named volume the
    // host has no view of it at all.
    const base = `/data/caddy/certificates/${LE_DIR}/a.com`;
    const e = exec({}, { [`${base}/a.com.crt`]: "CERT", [`${base}/a.com.key`]: "KEY" });
    expect(await caddyStoreCert(e, "a.com", "caddy")).toMatchObject({
      certPem: "CERT",
      keyPem: "KEY",
    });
  });

  it("returns null when there's no store (nothing to adopt)", async () => {
    expect(await caddyStoreCert(exec({}), "a.com")).toBeNull();
  });

  it("returns null when the key is missing — never a half pair", async () => {
    const base = `/var/lib/caddy/.local/share/caddy/certificates/${LE_DIR}/a.com`;
    expect(await caddyStoreCert(exec({ [`${base}/a.com.crt`]: "CERT" }), "a.com")).toBeNull();
  });
});
