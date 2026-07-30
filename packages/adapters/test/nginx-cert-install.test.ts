import { describe, expect, it, vi, afterEach } from "vitest";

import { NginxProvider } from "../src/infra/nginx";
import { makeTestCert } from "../src/system/proxy/test-certs";
import type { CommandExecutor } from "../src/types";

// installCert is the LAST gate before a cert reaches disk, and every path that
// puts one there funnels through it: operator upload, migration carry, cert reuse.
// verifyCert/readCertInfo is the matching read side — and the thing cert reuse
// trusts when it accepts a cert already sitting at certbot's path.

const HOST = "app.example.com";
const CERT_DIR = "/etc/letsencrypt/live";

/** A provider over an in-memory filesystem, recording writes and moves. */
function provider(files: Record<string, string> = {}) {
  const moves: Array<{ from: string; to: string }> = [];
  const executor = {
    exec: vi.fn(async (cmd: string) => {
      // `mv -f a b dir/` — model the rename so a staged pair lands together.
      const mv = cmd.match(/^mv -f '(.+)' '(.+)' '(.+)'\/$/);
      if (mv) {
        for (const src of [mv[1], mv[2]]) {
          const dest = `${mv[3]}/${src.split("/").pop()}`;
          files[dest] = files[src];
          delete files[src];
          moves.push({ from: src, to: dest });
        }
        return "";
      }
      const single = cmd.match(/^mv '(.+)' '(.+)'$/);
      if (single) {
        files[single[2]] = files[single[1]];
        delete files[single[1]];
        return "";
      }
      return "";
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      files[p] = c;
    }),
    readFile: vi.fn(async (p: string) => {
      if (files[p] === undefined) throw new Error(`ENOENT ${p}`);
      return files[p];
    }),
    exists: vi.fn(async (p: string) => files[p] !== undefined),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async (p: string) => {
      delete files[p];
    }),
  } as unknown as CommandExecutor;

  const nginx = new NginxProvider({
    paths: { sitesDir: "/etc/openresty/sites-enabled", binary: "openresty", confPath: "/x" } as never,
    executor,
    certDir: CERT_DIR,
    pinPaths: true,
  });
  return { nginx, files, executor, moves };
}

describe("NginxProvider.installCert", () => {
  afterEach(() => vi.useRealTimers());

  it("writes the pair and reports the real issuer for an ACME cert", async () => {
    const cert = makeTestCert([HOST], { issuerCN: "R11", issuerO: "Let's Encrypt" });
    const { nginx, files } = provider();

    const r = await nginx.installCert(HOST, cert);

    expect(r.verified).toBe(true);
    expect(r.issuer).toContain("R11");
    expect(files[`${CERT_DIR}/${HOST}/fullchain.pem`]).toBe(cert.certPem);
    expect(files[`${CERT_DIR}/${HOST}/privkey.pem`]).toBe(cert.keyPem);
  });

  it("reports issuer 'manual' for a cert certbot can't reissue", async () => {
    const cert = makeTestCert([HOST], { issuerCN: "Cloudflare Origin SSL CA", issuerO: "CloudFlare, Inc." });
    const { nginx } = provider();
    expect((await nginx.installCert(HOST, cert)).issuer).toBe("manual");
  });

  // Writing fullchain then privkey as two independent steps meant a failure between
  // them left the new cert beside the OLD key — a pair `openresty -t` rejects, which
  // takes down every domain on the edge, not just this one.
  it("stages the pair and moves BOTH files in a single mv", async () => {
    const cert = makeTestCert([HOST]);
    const { nginx, executor } = provider();
    await nginx.installCert(HOST, cert);

    const mvs = (executor.exec as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((c) => c.startsWith("mv -f"));
    expect(mvs).toHaveLength(1);
    expect(mvs[0]).toContain("fullchain.pem");
    expect(mvs[0]).toContain("privkey.pem");
  });

  it("leaves an existing cert untouched when the new one is rejected", async () => {
    const good = makeTestCert([HOST]);
    const { nginx, files } = provider({
      [`${CERT_DIR}/${HOST}/fullchain.pem`]: good.certPem,
      [`${CERT_DIR}/${HOST}/privkey.pem`]: good.keyPem,
    });

    await expect(nginx.installCert(HOST, makeTestCert(["other.example"]))).rejects.toThrow(
      /Invalid certificate/,
    );
    expect(files[`${CERT_DIR}/${HOST}/fullchain.pem`]).toBe(good.certPem);
  });

  describe("rejects, before touching disk", () => {
    const cases: Array<[string, () => { certPem: string; keyPem: string }, RegExp]> = [
      ["a cert for a different hostname", () => makeTestCert(["other.example"]), /not app\.example\.com/],
      [
        "a key that doesn't match the cert",
        () => ({ certPem: makeTestCert([HOST]).certPem, keyPem: makeTestCert([HOST, "x"]).keyPem }),
        /does not match/,
      ],
      ["unparseable material", () => ({ certPem: "nope", keyPem: "nope" }), /unreadable certificate/],
    ];

    for (const [label, make, expected] of cases) {
      it(label, async () => {
        const { nginx, files } = provider();
        await expect(nginx.installCert(HOST, make())).rejects.toThrow(expected);
        expect(Object.keys(files)).toHaveLength(0);
      });
    }

    it("an expired cert", async () => {
      const cert = makeTestCert([HOST], { days: 1 });
      const { nginx, files } = provider();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
      await expect(nginx.installCert(HOST, cert)).rejects.toThrow(/expired/);
      expect(Object.keys(files)).toHaveLength(0);
    });
  });
});

describe("NginxProvider.verifyCert", () => {
  afterEach(() => vi.useRealTimers());

  it("verifies a good cert on disk and reports its expiry", async () => {
    const cert = makeTestCert([HOST]);
    const { nginx } = provider({
      [`${CERT_DIR}/${HOST}/fullchain.pem`]: cert.certPem,
      [`${CERT_DIR}/${HOST}/privkey.pem`]: cert.keyPem,
    });
    const r = await nginx.verifyCert(HOST);
    expect(r.verified).toBe(true);
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("reports `missing` when there's no cert", async () => {
    const r = await provider().nginx.verifyCert(HOST);
    expect(r).toMatchObject({ verified: false, reason: "missing" });
  });

  // These three used to come back `verified: true` — so "Recheck SSL" showed green
  // on a cert browsers reject, and cert reuse adopted whatever sat at this path
  // (including something a cross-server migration had just carried in).
  it("reports `invalid`, NOT verified, for an EXPIRED cert on disk", async () => {
    const cert = makeTestCert([HOST], { days: 1 });
    const { nginx } = provider({
      [`${CERT_DIR}/${HOST}/fullchain.pem`]: cert.certPem,
      [`${CERT_DIR}/${HOST}/privkey.pem`]: cert.keyPem,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    expect(await nginx.verifyCert(HOST)).toMatchObject({ verified: false, reason: "invalid" });
  });

  it("reports `invalid` for a cert issued for another hostname", async () => {
    const cert = makeTestCert(["other.example"]);
    const { nginx } = provider({
      [`${CERT_DIR}/${HOST}/fullchain.pem`]: cert.certPem,
      [`${CERT_DIR}/${HOST}/privkey.pem`]: cert.keyPem,
    });
    expect(await nginx.verifyCert(HOST)).toMatchObject({ verified: false, reason: "invalid" });
  });

  it("reports `invalid` for a mismatched pair (a half-written cert dir)", async () => {
    const { nginx } = provider({
      [`${CERT_DIR}/${HOST}/fullchain.pem`]: makeTestCert([HOST]).certPem,
      [`${CERT_DIR}/${HOST}/privkey.pem`]: makeTestCert([HOST, "x"]).keyPem,
    });
    expect(await nginx.verifyCert(HOST)).toMatchObject({ verified: false, reason: "invalid" });
  });

  it("reports `read_error` (not missing) when the key can't be read", async () => {
    // A transient read failure must not downgrade a live `active` domain.
    const { nginx } = provider({
      [`${CERT_DIR}/${HOST}/fullchain.pem`]: makeTestCert([HOST]).certPem,
    });
    expect(await nginx.verifyCert(HOST)).toMatchObject({ verified: false, reason: "read_error" });
  });
});
