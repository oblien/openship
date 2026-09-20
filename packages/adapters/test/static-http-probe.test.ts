import { describe, it, expect } from "vitest";
import { __staticProbeInternals } from "../src/system/output-exists";

const { buildCommand, parseHttp, statusIsServed } = __staticProbeInternals;

/**
 * The static-route probe's shell text and its marker parsing ARE the contract, and
 * both are testable with no daemon and no edge.
 *
 * The distinction every assertion here defends: "we looked and it is broken" vs
 * "we could not look". A probe that reports the second as the first turns a
 * missing curl, or a firewalled loopback, into a false alarm on a working site.
 */

describe("buildCommand", () => {
  const P = "/opt/openship/static/releases/dep_1";

  it("always emits the two filesystem markers", () => {
    const cmd = buildCommand(P);
    expect(cmd).toContain(`if [ -e '${P}' ]; then echo FOUND; fi`);
    expect(cmd).toContain(`[ -f '${P}/index.html' ]`);
    expect(cmd.endsWith("true")).toBe(true);
  });

  it("omits the HTTP arm entirely with no hostname", () => {
    expect(buildCommand(P)).not.toContain("curl");
  });

  it("asks as the given host, on the routed path and edge port", () => {
    const cmd = buildCommand(P, {
      hostname: "example.com",
      requestPath: "/docs",
      edgePort: 8080,
    });
    // The Host header is the whole point: without it every request lands on
    // `default_server` and the answer says nothing about this route.
    expect(cmd).toContain("-H 'Host: example.com'");
    expect(cmd).toContain("'http://127.0.0.1:8080/docs'");
    expect(cmd).toContain("%{http_code} %{num_connects}");
  });

  it("defaults to / on port 80", () => {
    const cmd = buildCommand(P, { hostname: "example.com" });
    expect(cmd).toContain("'http://127.0.0.1:80/'");
  });

  it("guards curl behind command -v, so a missing curl is no signal", () => {
    expect(buildCommand(P, { hostname: "example.com" })).toContain(
      "command -v curl >/dev/null 2>&1",
    );
  });

  it("DROPS the HTTP arm for any hostname that isn't plainly a hostname", () => {
    // Defence in depth — these are sanitized upstream. Dropping the arm yields no
    // signal, which is always a safe answer; interpolating would not be.
    for (const hostname of [
      "evil'; rm -rf /; echo '",
      "a$(whoami)",
      "a`id`",
      "a b",
      "-flag",
      "",
    ]) {
      expect(buildCommand(P, { hostname })).not.toContain("curl");
    }
  });

  it("DROPS the HTTP arm for a path that isn't plainly a path", () => {
    for (const requestPath of ["/a b", "/../etc", "/x'y", "relative", "/a;b"]) {
      expect(buildCommand(P, { hostname: "example.com", requestPath })).not.toContain("curl");
    }
  });
});

describe("parseHttp", () => {
  it("reads a served status", () => {
    expect(parseHttp("FOUND\nINDEX\nHTTP 200 1\n")).toEqual({ status: 200, served: true });
  });

  it("reads a 404 as PROVEN not-served", () => {
    expect(parseHttp("FOUND\nHTTP 404 1\n")).toEqual({ status: 404, served: false });
  });

  it("returns NO SIGNAL when nothing accepted a connection", () => {
    // `000 0` — the edge never answered. Reporting served:false here would blame
    // the path for a probe that never reached it. This is the case curl's exit
    // code alone cannot separate from a slow-but-working edge, which is why the
    // command asks for num_connects.
    expect(parseHttp("FOUND\nINDEX\nHTTP 000 0\n")).toEqual({});
  });

  it("returns NO SIGNAL for a connected non-HTTP answer", () => {
    expect(parseHttp("HTTP 000 1\n")).toEqual({});
  });

  it("returns NO SIGNAL when curl was absent (no marker at all)", () => {
    expect(parseHttp("FOUND\nINDEX\n")).toEqual({});
  });
});

describe("statusIsServed", () => {
  it("counts 2xx/3xx as served — the edge resolved the route", () => {
    for (const s of [200, 204, 301, 304, 399]) expect(statusIsServed(s)).toBe(true);
  });

  it("does not make a 3xx enough to OVERRIDE a missing index", () => {
    // `statusIsServed` answers "did the edge resolve the route", which a 301 does.
    // It deliberately does NOT answer "did the doc root serve content", and the two
    // were conflated one layer up: the probe was answered 301 by the :80 block's own
    // HTTP→HTTPS upgrade — which returns BEFORE the doc root is consulted — so a
    // wrong Output Directory read as a healthy site. The probe now claims
    // `X-Forwarded-Proto: https` so it reaches the serve path, and
    // `outputFindingIsBroken` no longer lets a redirect override the filesystem
    // verdict. Both halves are asserted where they live; this pins the boundary.
    expect(statusIsServed(301)).toBe(true);
    expect(buildCommand("/opt/openship/static/releases/dep_1", { hostname: "shop.example" })).toContain(
      "X-Forwarded-Proto: https",
    );
  });

  it("counts 401/403 as SERVED — a policy answered a route that resolved", () => {
    // Basic auth, an edge rules guard, a geo rule. The files were found and the
    // vhost works; vetoing a deploy over this would revert a site behaving exactly
    // as configured.
    expect(statusIsServed(401)).toBe(true);
    expect(statusIsServed(403)).toBe(true);
  });

  it("counts 404 and 5xx as NOT served", () => {
    for (const s of [404, 410, 500, 502, 503]) expect(statusIsServed(s)).toBe(false);
  });
});
