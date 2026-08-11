import { describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { edgeFailureReason, edgeIsBroken, sanitizeEdgeVhosts } from "./detect";
import { LocalExecutor } from "../local-executor";
import { edgeDefaultCatchAllConf } from "../../infra/openresty-lua";
import type { CommandExecutor } from "../../types";

/**
 * These cover the three guards that decide whether Openship tears down a working
 * edge — the place where a wrong answer is an outage, not a warning.
 *
 * `sanitizeEdgeVhosts` is exercised with a REAL LocalExecutor against REAL files in
 * a temp dir, not a faked executor. That is deliberate: the bug it exists to prevent
 * lived in the shell script itself, and a mock that returns whatever the test says
 * cannot see a broken `grep`/`sed`. If the script stops working, this fails.
 */

const CATCH_ALL = `server {
    listen 80 default_server;
    server_name _;
    location / { return 404; }
}
`;

const REAL_VHOST_CLAIMING_DEFAULT = `server {
    listen 80 default_server;
    listen 443 ssl default_server;
    server_name onvo.me www.onvo.me;
    location / { proxy_pass http://127.0.0.1:39801; }
}
`;

const PLAIN_VHOST = `server {
    listen 80;
    server_name api.reflx.me;
    location / { proxy_pass http://127.0.0.1:3000; }
}
`;

describe("sanitizeEdgeVhosts (real shell, real files)", () => {
  it("drops catch-alls, strips default_server, leaves plain vhosts alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-vhosts-"));
    await writeFile(join(dir, "_default.conf"), CATCH_ALL);
    await writeFile(join(dir, "onvo.conf"), REAL_VHOST_CLAIMING_DEFAULT);
    await writeFile(join(dir, "api-reflx.conf"), PLAIN_VHOST);

    const said: string[] = [];
    await sanitizeEdgeVhosts(new LocalExecutor(), dir, (l) => said.push(l.message));

    const left = (await readdir(dir)).sort();
    // The catch-all is the file that crash-loops the edge — it must be gone, and no
    // `.osh` temp file may survive the in-place edit.
    expect(left).toEqual(["api-reflx.conf", "onvo.conf"]);

    const onvo = await readFile(join(dir, "onvo.conf"), "utf8");
    expect(onvo).not.toContain("default_server");
    // Stripping the flag must not damage the rest of the listen line.
    expect(onvo).toContain("listen 80;");
    expect(onvo).toContain("listen 443 ssl;");
    expect(onvo).toContain("server_name onvo.me www.onvo.me;");
    expect(onvo).toContain("proxy_pass http://127.0.0.1:39801;");

    // An untouched file stays byte-identical.
    expect(await readFile(join(dir, "api-reflx.conf"), "utf8")).toBe(PLAIN_VHOST);

    expect(said.join("\n")).toMatch(/Dropped catch-all vhost .*_default\.conf/);
    expect(said.join("\n")).toMatch(/Removed default_server from .*onvo\.conf/);
  });

  it("drops the REAL _default.conf a bare edge writes, both server blocks and all", async () => {
    // The synthetic fixture above is a 4-line stand-in; this feeds the actual bytes
    // `ensureOpenRestyConfig` puts on a bare box, because that file is what a
    // bare→container conversion carries into the mounted sites-enabled. It now holds
    // TWO server blocks — :80 and a `443 ssl default_server` presenting the edge's
    // placeholder cert (#431) — so if it ever survived this pass, nginx would see a
    // second 443 default beside the image's own and refuse to start: `[emerg] a
    // duplicate default server` is a permanent crash loop, not a degraded page.
    //
    // It gets dropped only because both blocks are `server_name _;`. That coupling is
    // invisible from openresty-lua.ts, which is the point of asserting it here.
    const dir = await mkdtemp(join(tmpdir(), "openship-vhosts-real-"));
    const real = edgeDefaultCatchAllConf({
      certPath: "/usr/local/openresty/nginx/conf/openship-default-cert/fullchain.pem",
      keyPath: "/usr/local/openresty/nginx/conf/openship-default-cert/privkey.pem",
    });
    expect(real).toContain("listen 443 ssl default_server;"); // guard the guard
    await writeFile(join(dir, "_default.conf"), real);
    await writeFile(join(dir, "api-reflx.conf"), PLAIN_VHOST);

    const said: string[] = [];
    await sanitizeEdgeVhosts(new LocalExecutor(), dir, (l) => said.push(l.message));

    expect(await readdir(dir)).toEqual(["api-reflx.conf"]);
    expect(said.join("\n")).toMatch(/Dropped catch-all vhost .*_default\.conf/);
  });

  it("is a no-op on an empty or missing dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-vhosts-empty-"));
    const said: string[] = [];
    await sanitizeEdgeVhosts(new LocalExecutor(), dir, (l) => said.push(l.message));
    await sanitizeEdgeVhosts(new LocalExecutor(), join(dir, "nope"), (l) => said.push(l.message));
    expect(said).toEqual([]);
  });

  it("is idempotent — a second pass changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-vhosts-idem-"));
    await writeFile(join(dir, "onvo.conf"), REAL_VHOST_CLAIMING_DEFAULT);
    await sanitizeEdgeVhosts(new LocalExecutor(), dir, () => {});
    const once = await readFile(join(dir, "onvo.conf"), "utf8");
    const said: string[] = [];
    await sanitizeEdgeVhosts(new LocalExecutor(), dir, (l) => said.push(l.message));
    expect(await readFile(join(dir, "onvo.conf"), "utf8")).toBe(once);
    expect(said).toEqual([]); // nothing left to report
  });

  it("materializes valid symlinks and removes dangling links before the container mounts them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-vhosts-links-"));
    const source = join(dir, "source.conf");
    const linked = join(dir, "linked.conf");
    const dangling = join(dir, "dangling.conf");
    await writeFile(source, PLAIN_VHOST);
    await symlink(source, linked);
    await symlink(join(dir, "missing.conf"), dangling);

    const said: string[] = [];
    await sanitizeEdgeVhosts(new LocalExecutor(), dir, (l) => said.push(l.message));

    expect((await lstat(linked)).isSymbolicLink()).toBe(false);
    expect(await readFile(linked, "utf8")).toBe(PLAIN_VHOST);
    expect(await readdir(dir)).not.toContain("dangling.conf");
    expect(said.join("\n")).toMatch(/Materialized linked edge vhost .*linked\.conf/);
    expect(said.join("\n")).toMatch(/Dropped dangling edge vhost link .*dangling\.conf/);
  });
});

/** Executor that returns one canned answer — fine here: only PARSING is under test. */
function answering(out: string): CommandExecutor {
  return { exec: vi.fn(async () => out) } as unknown as CommandExecutor;
}

describe("edgeIsBroken", () => {
  it("is true only for a definitively dead container", async () => {
    for (const state of ["restarting", "exited", "dead"]) {
      expect(await edgeIsBroken(answering(state))).toBe(true);
    }
  });

  it("is FALSE for running — and for anything it can't read", async () => {
    // The whole point: the caller stops our edge and restores the operator's proxy on
    // `true`, so an unreadable answer must never be that. A false positive here is an
    // outage on a box that was serving fine.
    for (const out of ["running", "created", "paused", "", "  ", "Error: No such object"]) {
      expect(await edgeIsBroken(answering(out))).toBe(false);
    }
    const throwing = { exec: vi.fn(async () => { throw new Error("docker gone"); }) } as unknown as CommandExecutor;
    expect(await edgeIsBroken(throwing)).toBe(false);
  });
});

describe("edgeFailureReason", () => {
  it("extracts the nginx [emerg] line", () => {
    const log = [
      "2026/07/28 20:58:29 [emerg] 1#1: a duplicate default server for 0.0.0.0:80 in /usr/local/openresty/nginx/conf/nginx.conf:40",
      "nginx: [emerg] a duplicate default server for 0.0.0.0:80 in /usr/local/openresty/nginx/conf/nginx.conf:40",
    ].join("\n");
    expect(edgeFailureReason(log)).toBe(
      "a duplicate default server for 0.0.0.0:80 in /usr/local/openresty/nginx/conf/nginx.conf:40",
    );
  });

  it("returns null for a HEALTHY edge's access log", () => {
    // The regression: the old "no [emerg] → use the last line" fallback quoted live
    // traffic as the reason the edge was down, on a box that was serving perfectly.
    const accessLog = [
      '162.158.130.4 - - [28/Jul/2026:22:44:26 +0000] "GET /v3/posts/inbox?limit=20 HTTP/1.1" 200 21803 "-" "onvo/8"',
      '172.69.90.230 - - [28/Jul/2026:22:44:32 +0000] "GET /favicon.ico HTTP/1.1" 404 19241 "-" "Mozilla/5.0"',
    ].join("\n");
    expect(edgeFailureReason(accessLog)).toBeNull();
    expect(edgeFailureReason("")).toBeNull();
  });
});
