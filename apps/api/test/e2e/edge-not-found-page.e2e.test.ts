/**
 * The unrouted-host page (#431), against a real OpenResty.
 *
 * Everything else that covers this asserts on config TEXT — that the generated
 * `nginx.conf` contains a `default_server`, that the HTML has no stray quote. None
 * of it can tell whether OpenResty accepts the config, and none of it can tell what
 * an unrouted host actually receives. Both of those were wrong at once after the
 * feature shipped:
 *
 *   - The only thing that ever parsed the generated config was `RUN openresty -t`
 *     in `apps/edge/Dockerfile`, and no workflow builds that image on a PR. A
 *     broken config would have been found at release time, on a build whose failure
 *     mode is "every routed site on the box is down".
 *   - `http://<box-ip>/` still served OpenResty's welcome page — 128 KB, version
 *     banner and all — because the per-target challenge vhost claimed the box's own
 *     IP as a `server_name` with no `location /`, so nginx fell through to its
 *     compiled-in `root html`. The catch-all was never reached, and every
 *     text-level assertion about the catch-all was still green.
 *
 * So this boots the REAL config in the REAL base image and asks it what it serves.
 * `openresty -t` runs first inside the same container, which makes this the
 * pre-merge equivalent of the Dockerfile's gate. The negative control at the end
 * proves the gate can still go red — a container test that silently stopped
 * exercising anything would look exactly like a passing one.
 *
 * Config text travels in the container's own command as quoted heredocs rather
 * than a bind mount: a mount only works when the daemon can see the host path,
 * which is false for a macOS temp dir under Colima and true in CI, i.e. the one
 * setup where a gate must not evaporate.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 * See test/helpers/docker-e2e.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DockerRuntime,
  EDGE_CHALLENGE_DIR,
  EDGE_CHALLENGE_URL_PREFIX,
  OPENRESTY_DEFAULT_PATHS,
  edgeChallengeVhostConf,
  edgeDefaultCatchAllConf,
  edgeDefaultCertPaths,
} from "@repo/adapters";
import type Dockerode from "dockerode";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The hostname the challenge vhost claims — production passes the box's own IP. */
const CLAIMED_HOST = "box.example.com";
/** A hostname nothing on the box knows: the case the page exists for. */
const UNROUTED_HOST = "nope.example";
const TOKEN = "openship-e2e-token";
const CERT_CN = "openship-edge-default";

const PLACEHOLDER_SUBJ = `/CN=${CERT_CN}`;
const { certPath, keyPath } = edgeDefaultCertPaths(OPENRESTY_DEFAULT_PATHS.confDir);
const CERT_DIR = dirname(certPath);
const SITES_DIR = OPENRESTY_DEFAULT_PATHS.sitesDir;
const CONF_PATH = `${OPENRESTY_DEFAULT_PATHS.confDir}/nginx.conf`;

/**
 * A stock `http {}` envelope for the BARE edge's files. A bare box's own
 * `nginx.conf` is its distribution's; what Openship writes there is
 * `sites-enabled/*.conf`, and that is what this test is for.
 */
const BARE_ENVELOPE = `
worker_processes 1;
events { worker_connections 128; }
http {
    include       ${OPENRESTY_DEFAULT_PATHS.confDir}/mime.types;
    default_type  application/octet-stream;
    include ${SITES_DIR}/*.conf;
}
`;

/** `cat > path <<'EOF'` — quoted delimiter, so nothing in the body is expanded. */
function heredoc(path: string, content: string): string {
  const delim = "OSH_EOF_a7f1";
  if (content.includes(delim)) throw new Error(`heredoc delimiter collides: ${path}`);
  return `cat > ${path} <<'${delim}'\n${content}\n${delim}\n`;
}

/** The image the edge is actually built FROM, read from the Dockerfile so a base
 *  bump can't leave this testing a version nothing ships. */
async function edgeBaseImage(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "apps/edge/Dockerfile"), "utf8");
  const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
  if (!from) throw new Error("apps/edge/Dockerfile has no FROM line");
  return from;
}

/**
 * The placeholder certificate, generated with the HOST openssl: the base image
 * ships libssl but not the CLI (that is what the Dockerfile's `apk add openssl` is
 * for), and nginx refuses to LOAD a config whose `ssl_certificate` is missing —
 * so without this the container could not start for a reason that has nothing to
 * do with what is under test. EC P-256, matching both writers.
 *
 * Cert and key are written to a temp dir and read back, NOT piped through
 * `-keyout /dev/stdout`: openssl `fopen`s that path, and when the process's stdout
 * is a pipe (every CI runner) rather than a tty it fails with "No such device or
 * address". Both real writers (nginx.ts, openresty-lua.ts) and the sibling tests
 * write the key to a file for the same reason.
 */
async function placeholderCert(): Promise<{ cert: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openship-edge-cert-"));
  try {
    const certFile = join(dir, "cert.pem");
    const keyFile = join(dir, "key.pem");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      PLACEHOLDER_SUBJ,
      "-out",
      certFile,
      "-keyout",
      keyFile,
    ]);
    const cert = await readFile(certFile, "utf8");
    const key = await readFile(keyFile, "utf8");
    if (!cert.includes("END CERTIFICATE") || !/BEGIN (EC )?PRIVATE KEY/.test(key)) {
      throw new Error(
        `unexpected openssl output:\ncert=${cert.slice(0, 120)}\nkey=${key.slice(0, 120)}`,
      );
    }
    return { cert, key };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  /** Subject CN the server presented, for the TLS calls. */
  certCn?: string;
}

/** One request with an explicit `Host`, which `fetch` refuses to set. */
function ask(port: number, path: string, host: string, tls?: { sni: string }): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const send = tls ? httpsRequest : httpRequest;
    const req = send(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: host },
        ...(tls ? { servername: tls.sni, rejectUnauthorized: false } : {}),
      },
      (res) => {
        // Read the peer certificate HERE, not on `end`: by the time the body is
        // complete node has released the socket and `res.socket` is null.
        const socket = res.socket as {
          getPeerCertificate?: () => { subject?: { CN?: string } };
        } | null;
        const certCn = tls ? socket?.getPeerCertificate?.()?.subject?.CN : undefined;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
            ...(tls ? { certCn } : {}),
          });
        });
      },
    );
    // Without this a stalled response hangs until vitest's own timeout, which
    // reports as "the test took 300s" and names nothing.
    req.setTimeout(15_000, () => req.destroy(new Error(`timed out: ${host}${path}`)));
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDockerE2E("edge unrouted-host page, real OpenResty", () => {
  let runtime: DockerRuntime;
  let image = "";
  let cert = { cert: "", key: "" };
  const started: Dockerode.Container[] = [];

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    image = await edgeBaseImage();
    await runtime.pullImage(image);
    cert = await placeholderCert();
  }, 300_000);

  afterAll(async () => {
    for (const c of started) await c.remove({ force: true }).catch(() => {});
    await runtime?.dispose().catch(() => {});
  });

  /**
   * Write `files` into a fresh container, prove the config loads, then run it and
   * hand back the published :80 / :443 ports. `openresty -t` runs first, so a
   * config OpenResty rejects fails here — with its own `[emerg]` line — instead of
   * as an unexplained connection refused.
   */
  async function boot(files: Record<string, string>): Promise<{ http: number; https: number }> {
    const script =
      `set -e\n` +
      // The token lives under the challenge location's `root`, at the URL path:
      // `try_files $uri =404` means the file has to be exactly where the URI says.
      `mkdir -p ${CERT_DIR} ${SITES_DIR} ${EDGE_CHALLENGE_DIR} /etc/letsencrypt\n` +
      heredoc(certPath, cert.cert) +
      heredoc(keyPath, cert.key) +
      heredoc(join(EDGE_CHALLENGE_DIR, TOKEN), TOKEN) +
      Object.entries(files)
        .map(([path, content]) => heredoc(path, content))
        .join("") +
      `openresty -t\n` +
      `exec openresty -g 'daemon off;'\n`;

    const container = await runtime.docker.createContainer({
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [script],
      // Raw stream, so a failure log needs no demux to be readable.
      Tty: true,
      ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
      HostConfig: {
        PortBindings: {
          "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
        AutoRemove: false,
      },
    });
    started.push(container);
    await container.start();

    const info = await container.inspect();
    const portOf = (spec: string): number => {
      const bound = info.NetworkSettings.Ports?.[spec]?.[0]?.HostPort;
      if (!bound) throw new Error(`docker published no host port for ${spec}`);
      return Number(bound);
    };
    const ports = { http: portOf("80/tcp"), https: portOf("443/tcp") };

    // Ready when it answers, dead when it exits — and a dead edge must report the
    // reason OpenResty gave, not a timeout.
    for (let i = 0; i < 60; i++) {
      const state = await container.inspect();
      if (!state.State.Running) {
        const log = (await container.logs({ stdout: true, stderr: true, tail: 40 })).toString();
        throw new Error(`edge exited (${state.State.ExitCode}):\n${log}`);
      }
      try {
        await ask(ports.http, "/", UNROUTED_HOST);
        return ports;
      } catch {
        await sleep(250);
      }
    }
    throw new Error("edge never answered on :80");
  }

  /** Run the same script but expect OpenResty to REJECT it. */
  async function bootExpectingFailure(conf: string): Promise<string> {
    const container = await runtime.docker.createContainer({
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [
        `mkdir -p ${CERT_DIR} ${SITES_DIR}\n` +
          heredoc(certPath, cert.cert) +
          heredoc(keyPath, cert.key) +
          heredoc(CONF_PATH, BARE_ENVELOPE) +
          heredoc(join(SITES_DIR, "_default.conf"), conf) +
          `openresty -t\n`,
      ],
      Tty: true,
    });
    started.push(container);
    await container.start();
    const exit = (await container.wait()) as { StatusCode: number };
    const log = (await container.logs({ stdout: true, stderr: true })).toString();
    expect(exit.StatusCode, `openresty -t ACCEPTED a broken config:\n${log}`).not.toBe(0);
    return log;
  }

  it("the shipped container config loads, and answers unrouted hosts with the page", async () => {
    // The checked-in file, not the generator: this is the byte-for-byte copy the
    // image COPYs, and a hand-edit of it is exactly the drift worth catching here.
    const baked = await readFile(join(REPO_ROOT, "apps/edge/nginx.conf"), "utf8");
    const ports = await boot({
      [CONF_PATH]: baked,
      [join(SITES_DIR, `_oblien-challenge-${CLAIMED_HOST.replace(/\./g, "-")}.conf`)]:
        edgeChallengeVhostConf(CLAIMED_HOST),
    });

    // 1. A hostname the box doesn't know, over plain HTTP.
    const unrouted = await ask(ports.http, "/", UNROUTED_HOST);
    expect(unrouted.status).toBe(404);
    expect(unrouted.body).toContain("Service not found");
    expect(unrouted.body).not.toContain("Welcome to OpenResty");
    // server_tokens off, scoped to the catch-all: a version banner on the most-seen
    // page the edge serves is free reconnaissance.
    expect(unrouted.headers.server).toBe("openresty");
    // A 200 would make an unrouted hostname look healthy to every uptime monitor.
    expect(unrouted.status).not.toBe(200);

    // 2. The regression this test exists for: the hostname CLAIMED by the challenge
    //    vhost. Its server_name beats the catch-all for every URI, so before it
    //    carried the page this answered 200 with OpenResty's 128 KB welcome page —
    //    which is the visit-by-IP report in #431, since edge-ensure passes the box's
    //    own IP as a routing target.
    const claimed = await ask(ports.http, "/", CLAIMED_HOST);
    expect(claimed.status).toBe(404);
    expect(claimed.body).toContain("Service not found");
    expect(claimed.body).not.toContain("Welcome to OpenResty");
    expect(claimed.body.length).toBeLessThan(8_000);

    // 3. And the page must not have swallowed the probe the vhost exists FOR. Only
    //    nginx's longest-prefix rule separates them.
    const probe = await ask(ports.http, `${EDGE_CHALLENGE_URL_PREFIX}${TOKEN}`, CLAIMED_HOST);
    expect(probe.status).toBe(200);
    expect(probe.body.trim()).toBe(TOKEN);

    // 4. Same for ACME on the catch-all. Nothing is listening on certbot's loopback
    //    port here, so a 502 is the PASS: it proves the request was proxied to
    //    certbot rather than answered by `location /`.
    const acme = await ask(ports.http, "/.well-known/acme-challenge/x", UNROUTED_HOST);
    expect([502, 504]).toContain(acme.status);

    // 5. HTTPS with unmatched SNI — the ERR_SSL_UNRECOGNIZED_NAME_ALERT / Cloudflare
    //    525 case. The handshake must COMPLETE, against the domain-less placeholder
    //    and never a real site's certificate, and then serve the same page.
    const tls = await ask(ports.https, "/", UNROUTED_HOST, { sni: UNROUTED_HOST });
    expect(tls.certCn).toBe(CERT_CN);
    expect(tls.status).toBe(404);
    expect(tls.body).toContain("Service not found");
    expect(tls.headers["strict-transport-security"]).toBeUndefined();
  }, 300_000);

  it("the bare edge's own files load beside each other and serve the same page", async () => {
    // `_default.conf` + a challenge vhost is what a legacy/Docker-less box gets from
    // `ensureOpenRestyConfig` + edge-ensure. Two files, written by different code
    // paths, that have to agree about who owns `default_server` — disagreeing is
    // `[emerg] a duplicate default server`, a permanent crash loop rather than a
    // missing page, which `openresty -t` inside `boot()` turns into this failing.
    const ports = await boot({
      [CONF_PATH]: BARE_ENVELOPE,
      [join(SITES_DIR, "_default.conf")]: edgeDefaultCatchAllConf({ certPath, keyPath }),
      [join(SITES_DIR, `_oblien-challenge-${CLAIMED_HOST.replace(/\./g, "-")}.conf`)]:
        edgeChallengeVhostConf(CLAIMED_HOST),
    });

    const unrouted = await ask(ports.http, "/", UNROUTED_HOST);
    expect(unrouted.status).toBe(404);
    expect(unrouted.body).toContain("Service not found");

    const claimed = await ask(ports.http, "/", CLAIMED_HOST);
    expect(claimed.status).toBe(404);
    expect(claimed.body).not.toContain("Welcome to OpenResty");

    const tls = await ask(ports.https, "/", UNROUTED_HOST, { sni: UNROUTED_HOST });
    expect(tls.certCn).toBe(CERT_CN);
    expect(tls.body).toContain("Service not found");
  }, 300_000);

  it("rejects a page body with a stray quote — the gate can still fail", async () => {
    // The negative control. The page is ~1.6 KB of HTML inlined in a `return`
    // directive; one `'` in it ends the token early and the whole config is invalid,
    // which at runtime is a crash-looping fresh edge or an existing one that refuses
    // this and every later reload. If this case ever passes, the two above have
    // stopped proving anything.
    const broken = edgeDefaultCatchAllConf({ certPath, keyPath }).replace(
      "Service not found</title>",
      "Service isn't found</title>",
    );
    expect(broken).toContain("isn't"); // guard the guard: the replace must have landed
    const log = await bootExpectingFailure(broken);
    expect(log).toMatch(/emerg|unexpected|invalid/i);
  }, 300_000);
});
