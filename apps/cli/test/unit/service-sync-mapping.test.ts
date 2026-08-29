import { describe, it, expect } from "vitest";

import { mapComposeService } from "../../src/commands/service";

/**
 * `openship service sync` maps `docker compose config --format json` to the sync
 * payload — and that mapper is a SECOND fold of compose's long form, independent
 * of the API's YAML parser. The two disagreed, which is the real half of #533's
 * mount claim: compose config ALWAYS normalizes volumes to long form, and this
 * mapper read only `source`/`target`, so every `:ro` a compose file declared was
 * lost on sync. The row stored a plain `src:target`, and a host directory the
 * author had marked read-only was bind-mounted WRITABLE, silently.
 *
 * The fold now lives once, in @repo/core. These cases are the fixtures compose
 * actually emits, so the CLI's use of it is pinned at the shape it really sees.
 */

const CONFIG_JSON_SERVICE = {
  image: "nginx:alpine",
  // Exactly what `docker compose config --format json` emits for
  // `- ./conf:/etc/nginx/conf.d:ro` — the short form is gone by this point.
  volumes: [
    { type: "bind", source: "/repo/conf", target: "/etc/nginx/conf.d", read_only: true, bind: {} },
    { type: "volume", source: "cache", target: "/var/cache", volume: {} },
  ],
  // And for `- "127.0.0.1:8080:80"`.
  ports: [
    { mode: "ingress", target: 80, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" },
  ],
};

describe("service sync — compose config JSON mapping", () => {
  it("keeps a read-only bind read-only", () => {
    const errors: string[] = [];
    const svc = mapComposeService("web", CONFIG_JSON_SERVICE, "/repo", errors);
    expect(svc.volumes).toEqual(["/repo/conf:/etc/nginx/conf.d:ro", "cache:/var/cache"]);
    expect(errors).toEqual([]);
  });

  it("keeps the bound interface on a loopback-only publish", () => {
    const errors: string[] = [];
    const svc = mapComposeService("web", CONFIG_JSON_SERVICE, "/repo", errors);
    expect(svc.ports).toEqual(["127.0.0.1:8080:80"]);
  });

  it("keeps normalized per-service build args, including bare values (#689)", () => {
    const errors: string[] = [];
    const svc = mapComposeService(
      "api",
      {
        build: {
          context: "/repo",
          dockerfile: "services/shared/Dockerfile",
          args: { APP_PACKAGE: "@myorg/api", EMPTY: "", FROM_ENV: null },
        },
      },
      "/repo",
      errors,
    );
    expect(svc).toMatchObject({
      build: ".",
      dockerfile: "services/shared/Dockerfile",
      buildArgs: { APP_PACKAGE: "@myorg/api", EMPTY: "", FROM_ENV: null },
      advanced: { buildArgTemplateKeys: [] },
    });
    expect(errors).toEqual([]);
  });

  it("refuses unsupported build behavior instead of silently dropping it", () => {
    const errors: string[] = [];
    mapComposeService(
      "api",
      {
        build: {
          context: "/repo",
          target: "release-with-private-token",
          ssh: ["default=super-secret-ssh-material"],
        },
      },
      "/repo",
      errors,
    );

    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("build.target");
    expect(errors.join("\n")).toContain("build.ssh");
    expect(errors.join("\n")).not.toContain("release-with-private-token");
    expect(errors.join("\n")).not.toContain("super-secret-ssh-material");
  });

  it("refuses malformed build args without echoing their names or values", () => {
    const errors: string[] = [];
    mapComposeService(
      "api",
      {
        build: {
          context: "/repo",
          args: {
            "INVALID-SECRET-NAME": "never-print-this-value",
            VALID_NAME: { secret: "never-print-this-object" },
          },
        },
      },
      "/repo",
      errors,
    );

    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes("build.args"))).toBe(true);
    expect(errors.join("\n")).not.toContain("INVALID-SECRET-NAME");
    expect(errors.join("\n")).not.toContain("never-print-this-value");
    expect(errors.join("\n")).not.toContain("never-print-this-object");
  });

  it("carries shared namespaces instead of dropping the advanced blob", () => {
    const errors: string[] = [];
    const svc = mapComposeService(
      "qbit",
      { image: "linuxserver/qbittorrent", network_mode: "service:gluetun", pid: "container:abc" },
      "/repo",
      errors,
    );
    expect(svc.advanced).toEqual({ networkMode: "service:gluetun", pidMode: "container:abc" });
    expect(errors).toEqual([]);
  });

  it("reports `host` as an error rather than syncing a service without it", () => {
    // The CLI's half of "error out instead of silently dropping": `sync` prints
    // these and exits non-zero, so the stack is never left describing something
    // the file didn't ask for.
    const errors: string[] = [];
    const svc = mapComposeService(
      "agent",
      { image: "prom/node-exporter", network_mode: "host" },
      "/repo",
      errors,
    );
    expect(svc.advanced).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("agent");
    expect(errors[0]).toContain("network_mode");
  });

  it("enforces the same blocking mount rules the API import does", () => {
    // Both doors, one policy. A file the wizard refuses must not sync cleanly here.
    const tmpfs: string[] = [];
    mapComposeService(
      "web",
      { image: "nginx", volumes: [{ type: "tmpfs", target: "/run/cache" }] },
      "/repo",
      tmpfs,
    );
    expect(tmpfs).toHaveLength(1);
    expect(tmpfs[0]).toContain("tmpfs");

    const subpath: string[] = [];
    mapComposeService(
      "web",
      {
        image: "nginx",
        volumes: [{ type: "volume", source: "data", target: "/d", volume: { subpath: "only" } }],
      },
      "/repo",
      subpath,
    );
    expect(subpath).toHaveLength(1);
    expect(subpath[0]).toContain("subpath");
  });

  it("does not refuse a non-blocking mount option", () => {
    const errors: string[] = [];
    const svc = mapComposeService(
      "web",
      {
        image: "nginx",
        volumes: [{ type: "bind", source: "/h", target: "/c", bind: { propagation: "rslave" } }],
      },
      "/repo",
      errors,
    );
    expect(errors).toEqual([]);
    expect(svc.volumes).toEqual(["/h:/c"]);
  });

  it("leaves a plain service untouched", () => {
    const errors: string[] = [];
    const svc = mapComposeService(
      "api",
      { image: "node:22", ports: [{ target: 3000, published: "3000", protocol: "tcp" }] },
      "/repo",
      errors,
    );
    expect(svc).toEqual({ name: "api", image: "node:22", ports: ["3000:3000"] });
    expect(errors).toEqual([]);
  });
});
