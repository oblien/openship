/**
 * The edge image's `nginx.conf`, built from the same constants the bare/remote
 * edge is patched with.
 *
 * WHY THIS IS GENERATED. `apps/edge/nginx.conf` is COPYed into the image and never
 * edited at runtime, so it cannot read a TypeScript constant — it used to be a
 * hand-maintained copy of one, carrying three "keep in sync" comments and guarded
 * only by string-match assertions. That guard catches a rename, not a divergent
 * VALUE: a dict sized 256m here and 16m there, an ACME port that moved, a
 * challenge root that moved. Those fail on one install path only, under load or
 * ~83 days later, which is the worst way to find out.
 *
 * So the file on disk is output, `bakedEdgeNginxConf()` is the source, and a test
 * asserts the two are equal. Regenerate with `bun run edge:conf` in this package.
 *
 * ONE thing here is not self-contained: the :443 catch-all names the placeholder
 * certificate at `edgeDefaultCertPaths(confDir)`, and OpenResty will not load a
 * config whose `ssl_certificate` is absent — so the image MUST create that pair at
 * build time. `apps/edge/Dockerfile` does, `RUN openresty -t` in the same file
 * proves it before the image is published, and a test asserts the Dockerfile and
 * this generator still name the same path.
 *
 * The comments are emitted INTO the conf on purpose. Whoever reads this file is
 * usually inside a container with no repo checkout, debugging routing at the worst
 * possible moment; a bare directive with its rationale left behind in a `.ts` file
 * they can't open is how a load-bearing block gets deleted as decoration.
 */

import { edgeRealIpConf } from "./edge-real-ip";
import { EDGE_NOT_FOUND_LOCATION } from "./edge-not-found";
import {
  ACME_CHALLENGE_LOCATION,
  EDGE_CHALLENGE_LOCATION,
  EDGE_LUA_PACKAGE_PATH,
  EDGE_MGMT_SERVER_BLOCK,
  EDGE_SERVER_NAMES_HASH_BUCKET_SIZE,
  EDGE_SHARED_DICTS,
  OPENRESTY_DEFAULT_PATHS,
  edgeDefaultCertPaths,
  edgeHttpsDefaultBlock,
} from "./openresty-lua";

/**
 * Re-indent a shared block for nesting.
 *
 * The shared constants are written for a top-level `server {}` in a
 * `sites-enabled` file; here everything sits one level deeper inside `http {}`.
 * Blank lines stay blank — trailing whitespace on an empty line is the kind of
 * diff noise that makes the freshness test look broken when it isn't.
 */
function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : pad + line))
    .join("\n");
}

/** Directory the image's logs and pid file live in (same place, baked path). */
const LOGS_DIR = OPENRESTY_DEFAULT_PATHS.pidPath.replace(/\/[^/]+$/, "");

/** The complete baked config, byte-for-byte as it must appear on disk. */
export function bakedEdgeNginxConf(): string {
  const dicts = EDGE_SHARED_DICTS.map((d) => `    lua_shared_dict ${d.name} ${d.size};`).join("\n");

  return `\
# Openship edge — baked, complete config for the CONTAINERIZED edge.
#
# GENERATED FILE — DO NOT EDIT. Source: packages/adapters/src/infra/edge-baked-conf.ts
# Regenerate with \`bun run edge:conf\` in packages/adapters. A test asserts this
# file matches its generator, so a hand edit here fails CI.
#
# It is generated because the directives below are shared with the bare/remote
# edge, which gets them patched in from TypeScript constants. This file cannot read
# those constants (it is COPYed into the image), and a hand-kept copy diverges on
# values — a dict size, a loopback port, a docroot — in ways that only break one
# install path, quietly.
#
# Nothing here is edited at runtime: the api writes managed vhosts into
# sites-enabled/*.conf (a host bind mount) and reloads via \`docker exec\`.
worker_processes auto;
error_log ${LOGS_DIR}/error.log warn;
pid ${OPENRESTY_DEFAULT_PATHS.pidPath};

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;

    # nginx sizes the server_name hash to the LONGEST server_name it loads, and
    # the 64-byte default rejects the whole config — \`could not build
    # server_names_hash\` fails \`nginx -t\`, so the reload is refused and NO route
    # change lands until the offending vhost is removed. A single long hostname
    # (a generated \`<project>-<service>.opsh.io\`, or any custom domain past ~63
    # chars) would otherwise wedge routing for every site on the box.
    server_names_hash_bucket_size ${EDGE_SERVER_NAMES_HASH_BUCKET_SIZE};

    # Shared-memory zones the openship Lua depends on (analytics counters, raw-log
    # ring buffers + live-log pipe, per-route rules cache, rate-limit counters).
    # Sizes come from EDGE_SHARED_DICTS — the same list the bare edge is patched
    # with, because a zone that is 256m on one edge and 16m on the other evicts
    # under load on exactly one of them.
${dicts}
    # OpenResty default lualib + the baked openship modules.
    lua_package_path "${EDGE_LUA_PACKAGE_PATH}";

${indent(edgeRealIpConf().trimEnd(), 4)}

    # Managed vhosts — the api drops <slug>.conf here (host bind mount). An empty
    # glob is not an error, so a fresh edge boots fine.
    include ${OPENRESTY_DEFAULT_PATHS.sitesDir}/*.conf;

    # Default catch-all. Answers the two probes that arrive addressed to a bare IP
    # (so \`Host:\` matches no server_name and only \`_\` is left), serves the branded
    # "service not found" page to every other unrouted host, and keeps the stock
    # OpenResty welcome page away.
    server {
        listen 80 default_server;
        server_name _;

        # ACME http-01 → certbot's transient standalone server on the loopback
        # alt-port. Zero-downtime issuance: certbot binds the port only while
        # issuing, LE hits :80 → here → certbot. No port-80 fight, no webroot.
${indent(ACME_CHALLENGE_LOCATION, 4)}

        # Openship Cloud's shared edge proves this box controls a routing target by
        # fetching a token from here. Serves FILES — only tokens we were actually
        # issued. An echo handler would let a third party register THIS box as
        # THEIR target and prove control with our own reply.
${indent(EDGE_CHALLENGE_LOCATION, 4)}

${indent(EDGE_NOT_FOUND_LOCATION, 4)}
    }

${indent(edgeHttpsDefaultBlock(edgeDefaultCertPaths(OPENRESTY_DEFAULT_PATHS.confDir)), 4)}

    # Internal analytics + live-log streaming API (loopback only). Queried by the
    # api over the Docker network / exec; never publicly exposed.
${indent(EDGE_MGMT_SERVER_BLOCK, 4)}
}
`;
}
