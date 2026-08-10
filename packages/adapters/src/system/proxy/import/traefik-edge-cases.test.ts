import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../../types";
import { parseTraefikLabels, scanTraefik, type TraefikContainer } from "./traefik";

/**
 * Traefik migration edge cases, written against the label sets real compose files
 * actually carry (traefik.io docs examples, and the two-router redirect pattern
 * every "Traefik + Let's Encrypt" tutorial teaches).
 *
 * The theme: a naive label read loses sites. Each test below is a shape that
 * either dropped a live site, sent traffic to the wrong port, or produced an
 * upstream reachable from nowhere.
 */

const box = (over: Partial<TraefikContainer> & { name: string }): TraefikContainer => ({
  labels: {},
  ip: "172.18.0.5",
  ...over,
});

const urlOf = (site: { target: { kind: string } } | undefined) =>
  (site?.target as { url?: string } | undefined)?.url;

describe("traefik: the canonical two-router redirect pattern", () => {
  // Straight out of every Traefik+ACME tutorial: a `web` router that redirects to
  // https, and a `websecure` router with the real TLS + service. Both carry the
  // SAME Host(), and one vhost file per host downstream means the plain-HTTP half
  // could overwrite the TLS half — the site would come back HTTP-only.
  const twoRouterLabels = {
    "traefik.enable": "true",
    "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme": "https",
    "traefik.http.routers.blog.rule": "Host(`blog.example.com`)",
    "traefik.http.routers.blog.entrypoints": "web",
    "traefik.http.routers.blog.middlewares": "redirect-to-https",
    "traefik.http.routers.blog-secure.rule": "Host(`blog.example.com`)",
    "traefik.http.routers.blog-secure.entrypoints": "websecure",
    "traefik.http.routers.blog-secure.tls.certresolver": "le",
    "traefik.http.routers.blog-secure.service": "blog",
    "traefik.http.services.blog.loadbalancer.server.port": "8080",
  };

  test("collapses to ONE site and keeps the TLS half", () => {
    const res = parseTraefikLabels([box({ name: "blog", labels: twoRouterLabels })]);

    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].serverNames).toEqual(["blog.example.com"]);
    expect(res.sites[0].ssl).toBe(true);
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:8080");
  });

  test("says it recognised the redirect half rather than staying silent", () => {
    const res = parseTraefikLabels([box({ name: "blog", labels: twoRouterLabels })]);
    expect(res.warnings.some((w) => /redirect/i.test(w) && w.includes("blog.example.com"))).toBe(
      true,
    );
    // …and does NOT nag about the redirect middleware as unmigrated config: the
    // edge performs that redirect natively.
    expect(res.warnings.some((w) => w.includes('middleware(s) "redirect-to-https"'))).toBe(false);
  });

  test("declaration order doesn't decide the winner — TLS does", () => {
    // Same config with the secure router declared FIRST.
    const flipped: Record<string, string> = {};
    for (const k of Object.keys(twoRouterLabels).reverse()) {
      flipped[k] = twoRouterLabels[k as keyof typeof twoRouterLabels];
    }
    const res = parseTraefikLabels([box({ name: "blog", labels: flipped })]);
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].ssl).toBe(true);
  });

  test("a host whose ONLY router is a redirect is still kept (never lose a hostname)", () => {
    const res = parseTraefikLabels([
      box({
        name: "old",
        labels: {
          "traefik.http.middlewares.to-https.redirectscheme.scheme": "https",
          "traefik.http.routers.old.rule": "Host(`old.example.com`)",
          "traefik.http.routers.old.middlewares": "to-https",
        },
      }),
    ]);
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].serverNames).toEqual(["old.example.com"]);
  });
});

describe("traefik: port and scheme resolution", () => {
  test("camelCase loadBalancer is the same knob as lowercase", () => {
    // Traefik lowercases label keys; the docs write `loadBalancer`. Matching only
    // the lowercase spelling silently fell back to :80 and every request 502'd.
    const res = parseTraefikLabels([
      box({
        name: "api",
        labels: {
          "traefik.http.routers.api.rule": "Host(`api.example.com`)",
          "traefik.http.routers.api.service": "api",
          "traefik.http.services.api.loadBalancer.server.port": "9000",
        },
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:9000");
  });

  test("scheme=https makes the UPSTREAM https, not just the listener", () => {
    // Talking plaintext to a TLS backend fails every request.
    const res = parseTraefikLabels([
      box({
        name: "sec",
        labels: {
          "traefik.http.routers.sec.rule": "Host(`sec.example.com`)",
          "traefik.http.routers.sec.service": "sec",
          "traefik.http.services.sec.loadbalancer.server.port": "8443",
          "traefik.http.services.sec.loadbalancer.server.scheme": "https",
        },
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("https://172.18.0.5:8443");
  });

  test("falls back to the container's single exposed port, like Traefik does", () => {
    const res = parseTraefikLabels([
      box({
        name: "app",
        labels: { "traefik.http.routers.app.rule": "Host(`app.example.com`)" },
        exposedPorts: ["3000/tcp"],
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:3000");
    expect(res.warnings).toEqual([]);
  });

  test("two exposed ports and no label is ambiguous — assumes :80 and SAYS so", () => {
    const res = parseTraefikLabels([
      box({
        name: "app",
        labels: { "traefik.http.routers.app.rule": "Host(`app.example.com`)" },
        exposedPorts: ["3000/tcp", "9229/tcp"],
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:80");
    expect(res.warnings.some((w) => w.includes("assumed :80"))).toBe(true);
  });

  test("a router names a service defined on ANOTHER container", () => {
    // Traefik merges labels from every container into one config, so this is legal
    // and common (a sidecar declaring the service for the app next to it).
    const res = parseTraefikLabels([
      box({
        name: "router-box",
        labels: {
          "traefik.http.routers.web.rule": "Host(`split.example.com`)",
          "traefik.http.routers.web.service": "elsewhere",
        },
      }),
      box({
        name: "svc-box",
        ip: "172.18.0.9",
        labels: { "traefik.http.services.elsewhere.loadbalancer.server.port": "7000" },
      }),
    ]);
    // The upstream IP is the ROUTER's container (that's what Traefik dials for a
    // docker-provider service), with the cross-container port applied.
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:7000");
  });

  test("a service@provider suffix on the router still resolves", () => {
    const res = parseTraefikLabels([
      box({
        name: "app",
        labels: {
          "traefik.http.routers.app.rule": "Host(`s.example.com`)",
          "traefik.http.routers.app.service": "app@docker",
          "traefik.http.services.app.loadbalancer.server.port": "4321",
        },
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:4321");
  });

  test("a non-numeric port label can't reach the generated config", () => {
    const res = parseTraefikLabels([
      box({
        name: "evil",
        labels: {
          "traefik.http.routers.e.rule": "Host(`e.example.com`)",
          "traefik.http.routers.e.service": "e",
          "traefik.http.services.e.loadbalancer.server.port": "80; proxy_pass http://evil",
        },
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.18.0.5:80");
  });
});

describe("traefik: multi-network containers", () => {
  test("traefik.docker.network decides which IP is dialled", () => {
    // With two networks the wrong IP is an upstream reachable from nowhere, and
    // Traefik's own answer to that ambiguity is this label.
    const res = parseTraefikLabels([
      box({
        name: "app",
        ip: undefined,
        networks: { backend: "10.5.0.2", proxy: "172.20.0.7" },
        labels: {
          "traefik.docker.network": "proxy",
          "traefik.http.routers.app.rule": "Host(`multi.example.com`)",
          "traefik.http.routers.app.service": "app",
          "traefik.http.services.app.loadbalancer.server.port": "3000",
        },
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.20.0.7:3000");
  });

  test("an unknown network name falls back rather than dropping the site", () => {
    const res = parseTraefikLabels([
      box({
        name: "app",
        ip: undefined,
        networks: { proxy: "172.20.0.7" },
        labels: {
          "traefik.docker.network": "does-not-exist",
          "traefik.http.routers.app.rule": "Host(`fb.example.com`)",
        },
      }),
    ]);
    expect(urlOf(res.sites[0])).toBe("http://172.20.0.7:80");
  });
});

describe("traefik: what we refuse to migrate, loudly", () => {
  test("tcp and udp routers warn — the edge is HTTP(S) only", () => {
    const res = parseTraefikLabels([
      box({
        name: "db",
        labels: {
          "traefik.tcp.routers.pg.rule": "HostSNI(`db.example.com`)",
          "traefik.tcp.routers.pg.service": "pg",
          "traefik.udp.routers.dns.rule": "HostSNI(`*`)",
        },
      }),
    ]);
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("tcp router") && w.includes("TCP/UDP"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("udp router"))).toBe(true);
  });

  test("a file provider is called out — its routes are in no label", () => {
    // Otherwise a file-provider user migrates a subset and is told nothing.
    const res = parseTraefikLabels([
      box({
        name: "traefik",
        cmd: "--providers.docker=true --providers.file.directory=/etc/traefik/dynamic --entrypoints.web.address=:80",
      }),
      box({
        name: "app",
        labels: { "traefik.http.routers.app.rule": "Host(`labelled.example.com`)" },
      }),
    ]);
    expect(res.sites).toHaveLength(1);
    expect(res.warnings.some((w) => w.includes("file provider"))).toBe(true);
  });

  test("exposedByDefault=false: a container without traefik.enable=true is NOT served, so it doesn't migrate", () => {
    const res = parseTraefikLabels([
      box({
        name: "traefik",
        cmd: "--providers.docker --providers.docker.exposedByDefault=false",
      }),
      box({
        name: "opted-in",
        labels: {
          "traefik.enable": "true",
          "traefik.http.routers.in.rule": "Host(`in.example.com`)",
        },
      }),
      box({
        name: "not-opted-in",
        labels: { "traefik.http.routers.out.rule": "Host(`out.example.com`)" },
      }),
    ]);
    expect(res.sites.map((s) => s.serverNames[0])).toEqual(["in.example.com"]);
  });
});

describe("traefik: rule parsing", () => {
  test("Host() || Host() alternation collects both hostnames", () => {
    const res = parseTraefikLabels([
      box({
        name: "a",
        labels: {
          "traefik.http.routers.r.rule": "Host(`a.example.com`) || Host(`b.example.com`)",
        },
      }),
    ]);
    expect(res.sites[0].serverNames).toEqual(["a.example.com", "b.example.com"]);
  });

  test("a hostname repeated across matchers isn't duplicated", () => {
    const res = parseTraefikLabels([
      box({
        name: "a",
        labels: {
          "traefik.http.routers.r.rule":
            "(Host(`a.example.com`) && PathPrefix(`/x`)) || (Host(`a.example.com`) && PathPrefix(`/y`))",
        },
      }),
    ]);
    expect(res.sites[0].serverNames).toEqual(["a.example.com"]);
  });

  test("uppercase HOST( and single quotes both parse", () => {
    const res = parseTraefikLabels([
      box({ name: "a", labels: { "traefik.http.routers.r.rule": "HOST('q.example.com')" } }),
    ]);
    expect(res.sites[0].serverNames).toEqual(["q.example.com"]);
  });

  test("tls=true (bare) counts as TLS, not just tls.certresolver", () => {
    const res = parseTraefikLabels([
      box({
        name: "a",
        labels: {
          "traefik.http.routers.r.rule": "Host(`t.example.com`)",
          "traefik.http.routers.r.tls": "true",
        },
      }),
    ]);
    expect(res.sites[0].ssl).toBe(true);
  });
});

describe("scanTraefik: the real docker-inspect shape", () => {
  const line = (
    name: string,
    labels: Record<string, string>,
    nets: string,
    ports = "",
    cmd = "",
  ) => `${name}\t${JSON.stringify(labels)}\t${nets}\t${ports}\t${cmd}`;

  test("parses name=ip network pairs and honours traefik.docker.network", async () => {
    const out = line(
      "/app",
      {
        "traefik.enable": "true",
        "traefik.docker.network": "proxy",
        "traefik.http.routers.app.rule": "Host(`app.example.com`)",
        "traefik.http.routers.app.service": "app",
        "traefik.http.services.app.loadbalancer.server.port": "3000",
      },
      "backend=10.5.0.2 proxy=172.20.0.7 ",
      "3000/tcp ",
    );
    const exec = {
      exec: async (cmd: string) => (cmd.includes("docker inspect") ? out : ""),
    } as unknown as CommandExecutor;

    const res = await scanTraefik(exec);
    expect(urlOf(res.sites[0])).toBe("http://172.20.0.7:3000");
  });

  test("tolerates a bare IP in the network column (no name= prefix)", async () => {
    const out = line(
      "/app",
      { "traefik.http.routers.app.rule": "Host(`bare.example.com`)" },
      "172.17.0.5 ",
    );
    const exec = {
      exec: async () => out,
    } as unknown as CommandExecutor;
    const res = await scanTraefik(exec);
    expect(urlOf(res.sites[0])).toBe("http://172.17.0.5:80");
  });

  test("keeps the traefik container itself (for its static flags) but emits no site for it", async () => {
    const out = [
      line("/traefik", {}, "proxy=172.20.0.2 ", "", "traefik --providers.file.directory=/dynamic"),
      line(
        "/app",
        { "traefik.http.routers.app.rule": "Host(`app.example.com`)" },
        "proxy=172.20.0.7 ",
      ),
    ].join("\n");
    const exec = { exec: async () => out } as unknown as CommandExecutor;

    const res = await scanTraefik(exec);
    expect(res.sites.map((s) => s.serverNames[0])).toEqual(["app.example.com"]);
    expect(res.warnings.some((w) => w.includes("file provider"))).toBe(true);
  });

  test("the authentic shape: labels captured from a live traefik v3.1 + compose stack", async () => {
    // Verbatim from `docker inspect` against a real `traefik:v3.1` + `traefik/whoami`
    // compose stack (19 compose-added labels alongside the traefik ones, two
    // networks, camelCase loadBalancer). This is the shape unit fixtures tend to
    // idealise away: compose label noise, `name=ip` pairs where the WRONG network
    // sorts first, and a distinctive port to prove the label was really read.
    const labels = {
      "com.docker.compose.project": "traefik-real",
      "com.docker.compose.service": "whoami",
      "org.opencontainers.image.title": "Whoami",
      "traefik.docker.network": "traefik-real_proxy",
      "traefik.enable": "true",
      "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme": "https",
      "traefik.http.routers.whoami-secure.entrypoints": "websecure",
      "traefik.http.routers.whoami-secure.rule": "Host(`whoami.example.com`)",
      "traefik.http.routers.whoami-secure.service": "whoami",
      "traefik.http.routers.whoami-secure.tls.certresolver": "le",
      "traefik.http.routers.whoami.entrypoints": "web",
      "traefik.http.routers.whoami.middlewares": "redirect-to-https",
      "traefik.http.routers.whoami.rule": "Host(`whoami.example.com`)",
      "traefik.http.services.whoami.loadBalancer.server.port": "9999",
    };
    const out = [
      line("/traefik-real-traefik-1", { "com.docker.compose.service": "traefik" }, "traefik-real_proxy=172.23.0.2 ", "80/tcp 443/tcp ", "--providers.docker=true --providers.docker.exposedByDefault=false --providers.file.directory=/etc/traefik/dynamic --entrypoints.web.address=:80"),
      // backend sorts BEFORE proxy, so a first-IP pick would take 172.22.0.2.
      line("/traefik-real-whoami-1", labels, "traefik-real_backend=172.22.0.2 traefik-real_proxy=172.23.0.4 ", "80/tcp "),
      line("/traefik-real-notexposed-1", { "traefik.http.routers.ghost.rule": "Host(`ghost.example.com`)" }, "traefik-real_proxy=172.23.0.5 ", "80/tcp "),
    ].join("\n");
    const exec = { exec: async () => out } as unknown as CommandExecutor;

    const res = await scanTraefik(exec);

    // One site, TLS kept, the PROXY network's IP, and the camelCase port.
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].serverNames).toEqual(["whoami.example.com"]);
    expect(res.sites[0].ssl).toBe(true);
    expect(urlOf(res.sites[0])).toBe("http://172.23.0.4:9999");
    // exposedByDefault=false ⇒ the un-labelled container is not a site.
    expect(res.sites.some((s) => s.serverNames.includes("ghost.example.com"))).toBe(false);
    expect(res.warnings.some((w) => w.includes("file provider"))).toBe(true);
  });

  test("a label value containing a tab can't shift columns into a wrong IP", async () => {
    const out = line(
      "/app",
      { "traefik.http.routers.app.rule": "Host(`safe.example.com`)", note: "a\\tb" },
      "proxy=172.20.0.7 ",
    );
    const exec = { exec: async () => out } as unknown as CommandExecutor;
    const res = await scanTraefik(exec);
    expect(urlOf(res.sites[0])).toBe("http://172.20.0.7:80");
  });
});
