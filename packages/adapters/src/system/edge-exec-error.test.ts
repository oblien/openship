import { describe, expect, it } from "vitest";

import {
  EDGE_DOWN_MARKER,
  edgeDownExplanation,
  explainEdgeDown,
  isEdgeDownFailure,
  isEdgeDownMessage,
} from "./edge-exec-error";

/** The exact strings this module exists to recognise, copied from a live incident. */
const DAEMON_RESTARTING =
  "Error response from daemon: Container b8968804d6a78cb51ae5151a0840eff7428b4a778380838c580c9f852d5771c7 " +
  "is restarting, wait until the container is running";
const NGINX_EMPTY_PID =
  `nginx: the configuration file /usr/local/openresty/nginx/conf/nginx.conf syntax is ok\n` +
  `nginx: configuration file /usr/local/openresty/nginx/conf/nginx.conf test is successful\n` +
  `2026/08/03 14:13:37 [notice] 14#14: signal process started\n` +
  `2026/08/03 14:13:37 [error] 14#14: invalid PID number "" in "/usr/local/openresty/nginx/logs/nginx.pid"`;

describe("isEdgeDownFailure", () => {
  it("recognises the daemon refusing an exec into a restarting container", () => {
    expect(isEdgeDownFailure(DAEMON_RESTARTING)).toBe(true);
  });

  it("recognises the 409 shape dockerode reports", () => {
    expect(
      isEdgeDownFailure("(HTTP code 409) unexpected - Container abc123 is not running"),
    ).toBe(true);
  });

  it("recognises a reload that found an EMPTY pid file", () => {
    // The subtle one. It arrives immediately after "test is successful", so it reads
    // as a config problem — but the container runs openresty as PID 1, so an empty
    // pid file means the master is already gone. Same crash loop, one moment earlier.
    expect(isEdgeDownFailure(NGINX_EMPTY_PID)).toBe(true);
  });

  it("recognises a container that has been removed or paused", () => {
    expect(isEdgeDownFailure("Error: No such container: openship-edge")).toBe(true);
    expect(isEdgeDownFailure("Container abc is paused, unpause it first")).toBe(true);
  });

  // The cost guard. Enrichment costs two extra `docker` round-trips, and on a healthy
  // box failed execs are ORDINARY — the container-file probes report a missing path by
  // exit code. Matching "any non-zero exit" would put that cost on every miss.
  it("does NOT fire on ordinary command failures", () => {
    for (const benign of [
      "",
      "cat: /etc/letsencrypt/live/x/fullchain.pem: No such file or directory",
      "nginx: [emerg] cannot load certificate \"/etc/letsencrypt/live/x/fullchain.pem\"",
      "Saving debug log to /var/log/letsencrypt/letsencrypt.log\nDNS problem: NXDOMAIN",
      "command exited 1 in edge container openship-edge",
    ]) {
      expect(isEdgeDownFailure(benign), `matched: ${benign}`).toBe(false);
    }
  });
});

describe("explainEdgeDown", () => {
  it("names the container, its state and the [emerg] cause", () => {
    const msg = explainEdgeDown({
      container: "openship-edge",
      status: "restarting",
      reason: 'cannot load certificate "/etc/letsencrypt/live/test.example.com/fullchain.pem"',
    });

    expect(msg).toContain('"openship-edge"');
    expect(msg).toContain("(restarting)");
    expect(msg).toContain("crash-looping");
    expect(msg).toContain("cannot load certificate");
    expect(msg).toContain("docker start openship-edge");
  });

  // Load-bearing: this string is joined into a deploy warning with "; " and handed to
  // certbot's summarizer, whose fallback keeps only the LAST THREE LINES. A paragraph
  // would reach the operator as fragments.
  it("is always a single line", () => {
    const withReason = explainEdgeDown({
      container: "openship-edge",
      status: "restarting",
      reason: "bind() to 0.0.0.0:80 failed (98: Address already in use)\n  extra noise",
    });
    expect(withReason).not.toContain("\n");
    expect(explainEdgeDown({ container: "openship-edge" })).not.toContain("\n");
  });

  it("falls back to pointing at the log when the cause can't be read", () => {
    const msg = explainEdgeDown({ container: "openship-edge", status: "exited", reason: null });
    expect(msg).toContain("docker logs --tail 40 openship-edge");
    // Not "crash-looping": `exited` needs starting, `restarting` will keep failing.
    // Telling an operator it's crash-looping when it merely stopped sends them
    // hunting for a config bug that isn't there.
    expect(msg).not.toContain("crash-looping");
  });

  it("still names the container when even the state is unreadable", () => {
    const msg = explainEdgeDown({ container: "openship-edge" });
    expect(msg).toContain('"openship-edge"');
    expect(msg).toContain(EDGE_DOWN_MARKER);
  });
});

describe("edgeDownExplanation / isEdgeDownMessage", () => {
  it("recovers our line from a blob that also holds the daemon's original error", () => {
    const explanation = explainEdgeDown({ container: "openship-edge", status: "restarting" });
    const blob = `Saving debug log to /var/log/letsencrypt\n${explanation}\n${DAEMON_RESTARTING}`;

    expect(edgeDownExplanation(blob)).toBe(explanation);
    expect(isEdgeDownMessage(blob)).toBe(true);
  });

  it("returns null for text that was never explained", () => {
    expect(edgeDownExplanation("DNS problem: NXDOMAIN looking up A for x.com")).toBeNull();
    expect(edgeDownExplanation("")).toBeNull();
  });

  // The advice-picking door: a caller choosing between "fix DNS" and "the edge is
  // down" must recognise the condition even from an UNENRICHED string, because a
  // warning can be assembled from a path that never went through an edge executor.
  it("classifies a raw, never-enriched daemon error as edge-down", () => {
    expect(isEdgeDownMessage(DAEMON_RESTARTING)).toBe(true);
    expect(isEdgeDownMessage("test.example.com: DNS problem: NXDOMAIN")).toBe(false);
  });
});
