import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../../types";
import { parseTraefikLabels, scanTraefik, type TraefikContainer } from "./traefik";

const c = (name: string, labels: Record<string, string>, ip = "172.17.0.5"): TraefikContainer => ({
  name,
  labels,
  ip,
});

describe("parseTraefikLabels", () => {
  test("simple Host() router → one upstream to the container ip:service-port", () => {
    const res = parseTraefikLabels([
      c("app", {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`app.example.com`)",
        "traefik.http.routers.web.service": "app",
        "traefik.http.services.app.loadbalancer.server.port": "3000",
      }),
    ]);
    expect(res.sites).toEqual([
      {
        serverNames: ["app.example.com"],
        ssl: false,
        target: { kind: "proxy", url: "http://172.17.0.5:3000" },
        source: "traefik container app",
      },
    ]);
    expect(res.warnings).toEqual([]);
  });

  test("tls label → ssl:true (both `.tls` and `.tls.certresolver` forms)", () => {
    const res = parseTraefikLabels([
      c("a", {
        "traefik.http.routers.r.rule": "Host(`a.com`)",
        "traefik.http.routers.r.tls.certresolver": "le",
      }),
    ]);
    expect(res.sites[0]?.ssl).toBe(true);
  });

  test("multiple hosts in one rule → all serverNames", () => {
    const res = parseTraefikLabels([
      c("a", { "traefik.http.routers.r.rule": "Host(`a.com`, `b.com`)" }),
    ]);
    expect(res.sites[0]?.serverNames).toEqual(["a.com", "b.com"]);
  });

  test("PathPrefix beyond Host → migrates Host, warns about the path rule (not dropped)", () => {
    const res = parseTraefikLabels([
      c("a", { "traefik.http.routers.r.rule": "Host(`a.com`) && PathPrefix(`/api`)" }),
    ]);
    expect(res.sites[0]?.serverNames).toEqual(["a.com"]);
    expect(res.warnings.some((w) => w.includes("PathPrefix"))).toBe(true);
  });

  test("middleware → surfaced as a coverage warning", () => {
    const res = parseTraefikLabels([
      c("a", {
        "traefik.http.routers.r.rule": "Host(`a.com`)",
        "traefik.http.routers.r.middlewares": "auth@docker",
      }),
    ]);
    expect(res.warnings.some((w) => w.includes("middleware"))).toBe(true);
  });

  test("router with no Host() (path-only) → warned, no site", () => {
    const res = parseTraefikLabels([
      c("a", { "traefik.http.routers.r.rule": "PathPrefix(`/only`)" }),
    ]);
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("no Host()"))).toBe(true);
  });

  test("HostRegexp → warned as not migratable", () => {
    const res = parseTraefikLabels([
      c("a", { "traefik.http.routers.r.rule": "HostRegexp(`{sub:[a-z]+}.example.com`)" }),
    ]);
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("HostRegexp"))).toBe(true);
  });

  test("traefik.enable=false container is skipped entirely", () => {
    const res = parseTraefikLabels([
      c("a", {
        "traefik.enable": "false",
        "traefik.http.routers.r.rule": "Host(`a.com`)",
      }),
    ]);
    expect(res.sites).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  test("no container IP → warns to re-add the upstream manually (no site)", () => {
    const res = parseTraefikLabels([
      { name: "a", labels: { "traefik.http.routers.r.rule": "Host(`a.com`)" }, ip: undefined },
    ]);
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("couldn't resolve") && w.includes("IP"))).toBe(true);
  });
});

describe("scanTraefik (docker-inspect I/O wrapper)", () => {
  test("parses tab-delimited inspect output; only traefik-labeled containers become sites", async () => {
    const appLabels = {
      "traefik.enable": "true",
      "traefik.http.routers.web.rule": "Host(`a.com`)",
      "traefik.http.routers.web.service": "app",
      "traefik.http.services.app.loadbalancer.server.port": "3000",
    };
    const line1 = `/app\t${JSON.stringify(appLabels)}\t172.17.0.5 `;
    const line2 = `/db\t${JSON.stringify({ foo: "bar" })}\t172.17.0.6 `; // no traefik labels → skipped
    const exec = {
      exec: async (cmd: string) => (cmd.includes("docker inspect") ? `${line1}\n${line2}` : ""),
    } as unknown as CommandExecutor;

    const res = await scanTraefik(exec);
    expect(res.sites).toEqual([
      {
        serverNames: ["a.com"],
        ssl: false,
        target: { kind: "proxy", url: "http://172.17.0.5:3000" },
        source: "traefik container app",
      },
    ]);
  });

  test("warns (never throws) when docker inspect returns nothing", async () => {
    const exec = { exec: async () => "" } as unknown as CommandExecutor;
    const res = await scanTraefik(exec);
    expect(res.sites).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});
