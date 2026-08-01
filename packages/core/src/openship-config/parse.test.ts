import { describe, it, expect } from "vitest";
import { parseOpenshipConfig, parseOpenshipConfigJson } from "./parse";

describe("parseOpenshipConfig", () => {
  it("accepts a full, valid config and strips undefined fields", () => {
    const { config, errors, warnings } = parseOpenshipConfig({
      framework: "nextjs",
      packageManager: "pnpm",
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      outputDirectory: ".next",
      productionPaths: [".next", "public"],
      volumes: ["storage", "uploads:/app/public/uploads"],
      runtime: "docker",
      productionMode: "standalone",
      port: 3000,
      env: { PUBLIC_URL: "https://x", API_KEY: { value: "sk_1", secret: true } },
      domains: ["app.example.com", { domain: "api.example.com", port: 8080, type: "custom" }],
      routes: { cleanUrls: true, redirects: [{ source: "/old", destination: "/new", permanent: true }] },
      resources: { tier: "medium" },
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      framework: "nextjs",
      runtime: "docker",
      port: 3000,
      env: { PUBLIC_URL: "https://x", API_KEY: { value: "sk_1", secret: true } },
      resources: { tier: "medium" },
    });
    expect(config?.volumes).toEqual(["storage", "uploads:/app/public/uploads"]);
    // normalized domains: string → object
    expect(config?.domains?.[0]).toEqual({ domain: "app.example.com" });
    expect(config?.domains?.[1]).toMatchObject({ domain: "api.example.com", port: 8080, type: "custom" });
    // no stray undefined keys
    expect(Object.values(config as object).every((v) => v !== undefined)).toBe(true);
  });

  it("rejects an unknown framework and out-of-range port", () => {
    const { errors } = parseOpenshipConfig({ framework: "coldfusion", port: 99999 });
    expect(errors.some((e) => e.startsWith("framework:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("port:"))).toBe(true);
  });

  it("rejects a bad enum (runtime) and bad resource range", () => {
    const { errors } = parseOpenshipConfig({ runtime: "vm", resources: { cpuCores: 99999 } });
    expect(errors.some((e) => e.startsWith("runtime:"))).toBe(true);
    expect(errors.some((e) => e.includes("resources.cpuCores"))).toBe(true);
  });

  // The bounds here are sanity rails, not the real ceiling — that's the target
  // machine's probed capacity, enforced server-side. A flat 4-core / 8192 MB max
  // used to make a large self-hosted box impossible to describe.
  it("accepts resource values a big self-hosted box can actually back", () => {
    const { errors, config } = parseOpenshipConfig({
      resources: { cpuCores: 32, memoryMb: 131072 },
    });
    expect(errors.filter((e) => e.includes("resources"))).toEqual([]);
    expect(config?.resources).toMatchObject({ cpuCores: 32, memoryMb: 131072 });
  });

  it("accepts 0 (no limit) and the unlimited tier", () => {
    const { errors, config } = parseOpenshipConfig({
      resources: { tier: "unlimited", cpuCores: 0, memoryMb: 0 },
    });
    expect(errors.filter((e) => e.includes("resources"))).toEqual([]);
    expect(config?.resources).toMatchObject({ tier: "unlimited", cpuCores: 0, memoryMb: 0 });
  });

  it("parses per-service resources (parity with compose mem_limit)", () => {
    const { errors, config } = parseOpenshipConfig({
      services: [{ name: "api", image: "x", resources: { memoryMb: 4096 } }],
    });
    expect(errors).toEqual([]);
    expect(config?.services?.[0]?.resources).toMatchObject({ memoryMb: 4096 });
  });

  it("coerces a string port and validates env value shape", () => {
    const ok = parseOpenshipConfig({ port: "8080", env: { A: "1" } });
    expect(ok.errors).toEqual([]);
    expect(ok.config?.port).toBe(8080);
    const bad = parseOpenshipConfig({ env: { A: { secret: true } } }); // missing value
    expect(bad.errors.some((e) => e.includes("env.A.value"))).toBe(true);
  });

  it("validates a service and requires its name", () => {
    const ok = parseOpenshipConfig({
      services: [{ name: "db", image: "postgres:17", ports: ["5432"], restart: "unless-stopped" }],
    });
    expect(ok.errors).toEqual([]);
    expect(ok.config?.services?.[0]).toMatchObject({ name: "db", restart: "unless-stopped" });
    const noName = parseOpenshipConfig({ services: [{ image: "x" }] });
    expect(noName.errors.some((e) => e.includes("requires a `name`"))).toBe(true);
    const badRestart = parseOpenshipConfig({ services: [{ name: "x", restart: "sometimes" }] });
    expect(badRestart.errors.some((e) => e.includes("restart"))).toBe(true);
  });

  it("warns on unknown top-level keys but does not error", () => {
    const { errors, warnings, config } = parseOpenshipConfig({ framework: "vite", nope: 1 });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("nope"))).toBe(true);
    expect(config?.framework).toBe("vite");
  });

  it("reports invalid JSON and non-object roots", () => {
    expect(parseOpenshipConfigJson("{ not json").errors[0]).toMatch(/invalid JSON/);
    expect(parseOpenshipConfig([]).config).toBeNull();
    expect(parseOpenshipConfig("x").errors[0]).toMatch(/must be a JSON object/);
  });

  // The examples printed in the docs/skill must validate cleanly, or the docs
  // are lying. Keep these in sync with reference/openship-json.mdx.
  it("accepts every documented example with no errors", () => {
    const examples = [
      { $schema: "x", framework: "vite", buildCommand: "pnpm build", outputDirectory: "dist", productionMode: "static" },
      {
        $schema: "x", framework: "nextjs", port: 3000, runtime: "docker",
        env: { NEXT_PUBLIC_URL: "https://app.acme.com", DATABASE_URL: { value: "postgres://…", secret: true } },
        domains: ["app.acme.com"],
      },
      {
        $schema: "x",
        services: [
          { name: "web", build: ".", ports: ["3000"], exposed: true, domain: "app.acme.com" },
          { name: "db", image: "postgres:17", volumes: ["pgdata:/var/lib/postgresql/data"], env: { POSTGRES_PASSWORD: { value: "…", secret: true } }, restart: "unless-stopped" },
        ],
      },
      {
        $schema: "x",
        monorepo: {
          workspace: { packageManager: "pnpm", prepareCommand: "pnpm install && pnpm codegen" },
          apps: [
            { name: "web", rootDirectory: "apps/web", framework: "nextjs", port: 3000 },
            { name: "api", rootDirectory: "apps/api", framework: "hono", port: 8080 },
          ],
        },
      },
      { $schema: "x", domains: ["app.acme.com", { domain: "api.acme.com", port: 8080, type: "custom" }] },
      { composePath: "deploy/docker-compose/docker-compose.yml" },
    ];
    for (const ex of examples) {
      const { errors } = parseOpenshipConfig(ex);
      expect(errors, JSON.stringify(ex)).toEqual([]);
    }
  });

  describe("composePath", () => {
    it("round-trips a file path and a directory path", () => {
      for (const composePath of ["deploy/docker-compose/docker-compose.yml", "deploy/docker-compose"]) {
        const { config, errors, warnings } = parseOpenshipConfig({ composePath });
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);
        expect(config?.composePath).toBe(composePath);
      }
    });

    it("rejects a non-string", () => {
      const { errors } = parseOpenshipConfig({ composePath: 42 });
      expect(errors).toEqual(["composePath: must be a string"]);
    });

    it("is absent (not undefined-valued) when undeclared", () => {
      const { config } = parseOpenshipConfig({ framework: "nextjs" });
      expect(config && "composePath" in config).toBe(false);
    });
  });

  describe("readiness", () => {
    it("round-trips every field", () => {
      const readiness = {
        enabled: true,
        path: "/healthz",
        port: 8080,
        timeoutSeconds: 90,
        stabilization: true,
        stabilizationSeconds: 30,
        onFailure: "fail" as const,
      };
      const { config, errors, warnings } = parseOpenshipConfig({ readiness });
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(config?.readiness).toEqual(readiness);
    });

    // The whole feature is opt-in, so "undeclared" has to stay distinguishable
    // from "declared off" all the way down to the persisted column.
    it("is absent (not undefined-valued) when undeclared", () => {
      const { config } = parseOpenshipConfig({ framework: "nextjs" });
      expect(config && "readiness" in config).toBe(false);
    });

    it("accepts an empty object as a legal no-op", () => {
      const { config, errors } = parseOpenshipConfig({ readiness: {} });
      expect(errors).toEqual([]);
      expect(config?.readiness).toEqual({
        enabled: undefined,
        path: undefined,
        port: undefined,
        timeoutSeconds: undefined,
        stabilization: undefined,
        stabilizationSeconds: undefined,
        onFailure: undefined,
      });
    });

    it("rejects a non-object", () => {
      const { errors } = parseOpenshipConfig({ readiness: true });
      expect(errors).toEqual(["readiness: must be an object"]);
    });

    it("rejects an unknown onFailure action", () => {
      const { errors } = parseOpenshipConfig({ readiness: { onFailure: "destroy" } });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(" ")).toContain("readiness.onFailure");
    });

    it("rejects out-of-range timeouts rather than silently clamping", () => {
      const { errors } = parseOpenshipConfig({
        readiness: { timeoutSeconds: 0, stabilizationSeconds: 9999 },
      });
      expect(errors.join(" ")).toContain("readiness.timeoutSeconds");
      expect(errors.join(" ")).toContain("readiness.stabilizationSeconds");
    });

    it("parses a PER-SERVICE readiness gate alongside the docker healthcheck", () => {
      const { config, errors } = parseOpenshipConfig({
        readiness: { stabilization: true },
        services: [
          {
            name: "api",
            image: "x",
            healthcheck: { test: "curl -f localhost/health" },
            readiness: { enabled: true, path: "/ready", onFailure: "fail" },
          },
        ],
      });
      expect(errors).toEqual([]);
      // Both coexist on one service: the daemon-run command AND the deploy gate.
      expect(config?.services?.[0]?.healthcheck?.test).toBe("curl -f localhost/health");
      expect(config?.services?.[0]?.readiness).toMatchObject({
        enabled: true,
        path: "/ready",
        onFailure: "fail",
      });
      // The project-level one is independent of the per-service override.
      expect(config?.readiness).toMatchObject({ stabilization: true });
    });

    it("validates a per-service readiness gate with the same rules", () => {
      const { errors } = parseOpenshipConfig({
        services: [{ name: "api", image: "x", readiness: { onFailure: "destroy" } }],
      });
      expect(errors.join(" ")).toContain("services[0].readiness.onFailure");
    });

    it("is not confused with a compose service's docker healthcheck", () => {
      // Different layers, similar names: `services[].healthcheck` is the Docker
      // HEALTHCHECK directive; top-level `readiness` is Openship's deploy gate.
      const { config, errors } = parseOpenshipConfig({
        readiness: { enabled: true },
        services: [{ name: "db", image: "postgres:16", healthcheck: { test: "pg_isready" } }],
      });
      expect(errors).toEqual([]);
      expect(config?.readiness?.enabled).toBe(true);
      expect(config?.services?.[0]?.healthcheck?.test).toBe("pg_isready");
    });
  });
});
