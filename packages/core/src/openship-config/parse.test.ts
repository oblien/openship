import { describe, it, expect } from "vitest";
import { parseOpenshipConfig, parseOpenshipConfigJson } from "./parse";

describe("parseOpenshipConfig", () => {
  it.each(["web\nEOF\nprintf injected\n#", "web;id", "$(id)", "two services", "-option"])("rejects unsafe service name %s", name => {
    const { config, errors } = parseOpenshipConfig({ services: [{ name, image: "nginx:alpine" }] });
    expect(errors.length).toBeGreaterThan(0);
    expect(config?.services ?? []).toEqual([]);
  });
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
      routes: {
        cleanUrls: true,
        redirects: [{ source: "/old", destination: "/new", permanent: true }],
      },
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
    expect(config?.domains?.[1]).toMatchObject({
      domain: "api.example.com",
      port: 8080,
      type: "custom",
    });
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

  it("parses per-service Docker build args with project-env inheritance", () => {
    const { config, errors } = parseOpenshipConfig({
      services: [
        {
          name: "admin",
          build: ".",
          dockerfile: "Dockerfile",
          buildArgs: {
            DATABASE_URI: null,
            NEXT_PUBLIC_API_URL: "https://api.example.com",
          },
        },
      ],
    });

    expect(errors).toEqual([]);
    expect(config?.services?.[0]?.buildArgs).toEqual({
      DATABASE_URI: null,
      NEXT_PUBLIC_API_URL: "https://api.example.com",
    });
  });

  it("rejects invalid native Docker build args before deployment", () => {
    const { config, errors } = parseOpenshipConfig({
      services: [{ name: "admin", build: ".", buildArgs: { "BAD-KEY": "x", PORT: 3000 } }],
    });

    expect(config?.services?.[0]?.buildArgs).toEqual({});
    expect(errors).toEqual([
      "services[0].buildArgs.BAD-KEY: has an invalid build argument name",
      "services[0].buildArgs.PORT: must be a string or null",
    ]);
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

  // #641 read this the other way round — that one bad enum nulls the config and
  // discards its valid siblings. It doesn't, and the reporting fix's severity
  // split (whole-file vs field) depends on which of the two actually happens.
  it("keeps the valid fields when one field fails validation", () => {
    const { config, errors } = parseOpenshipConfig({ framework: "nextjs ", port: 8080 });
    expect(config).not.toBeNull();
    expect(config?.port).toBe(8080);
    expect(config?.framework).toBeUndefined();
    expect(errors.some((e) => e.startsWith("framework:"))).toBe(true);
  });

  it("nulls the config ONLY for a syntax error or a non-object root", () => {
    expect(parseOpenshipConfigJson("{ not json").config).toBeNull();
    expect(parseOpenshipConfigJson("null").config).toBeNull();
    expect(parseOpenshipConfigJson("[]").config).toBeNull();
    // An object root always yields a config, however many fields it refused.
    expect(parseOpenshipConfigJson('{"framework":"coldfusion"}').config).toEqual({});
  });

  // The examples printed in the docs/skill must validate cleanly, or the docs
  // are lying. Keep these in sync with reference/openship-json.mdx.
  it("accepts every documented example with no errors", () => {
    const examples = [
      {
        $schema: "x",
        framework: "vite",
        buildCommand: "pnpm build",
        outputDirectory: "dist",
        productionMode: "static",
      },
      {
        $schema: "x",
        framework: "nextjs",
        port: 3000,
        runtime: "docker",
        env: {
          NEXT_PUBLIC_URL: "https://app.acme.com",
          DATABASE_URL: { value: "postgres://…", secret: true },
        },
        domains: ["app.acme.com"],
      },
      {
        $schema: "x",
        services: [
          { name: "web", build: ".", ports: ["3000"], exposed: true, domain: "app.acme.com" },
          {
            name: "db",
            image: "postgres:17",
            volumes: ["pgdata:/var/lib/postgresql/data"],
            env: { POSTGRES_PASSWORD: { value: "…", secret: true } },
            restart: "unless-stopped",
          },
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
      {
        $schema: "x",
        domains: ["app.acme.com", { domain: "api.acme.com", port: 8080, type: "custom" }],
      },
      { composePath: "deploy/docker-compose/docker-compose.yml" },
    ];
    for (const ex of examples) {
      const { errors } = parseOpenshipConfig(ex);
      expect(errors, JSON.stringify(ex)).toEqual([]);
    }
  });

  describe("monorepo override roots (#873)", () => {
    it.each([
      ["platform/dashboard_web", "./platform/dashboard_web/"],
      [".", "./"],
      ["apps\\web", "apps/web"],
    ])("rejects duplicate monorepo override roots %s and %s (#873)", (first, second) => {
      const { config, errors } = parseOpenshipConfig({
        monorepo: {
          apps: [
            { name: "web", rootDirectory: first },
            { name: "worker", rootDirectory: second },
          ],
        },
      });
      expect(errors).toEqual([
        expect.stringMatching(/monorepo\.apps\[1\]\.rootDirectory: duplicates monorepo\.apps\[0\]/),
      ]);
      expect(config?.monorepo?.apps).toHaveLength(1);
    });
  });

  describe("composePath", () => {
    it("round-trips a file path and a directory path", () => {
      for (const composePath of [
        "deploy/docker-compose/docker-compose.yml",
        "deploy/docker-compose",
      ]) {
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

  describe("releaseCommands", () => {
    it("round-trips a list of commands in declared order", () => {
      const releaseCommands = [
        "php artisan migrate --force",
        "php artisan db:seed --force",
      ];
      const { config, errors, warnings } = parseOpenshipConfig({ releaseCommands });
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(config?.releaseCommands).toEqual(releaseCommands);
    });

    it("rejects a bare string and a non-string entry", () => {
      expect(parseOpenshipConfig({ releaseCommands: "php artisan migrate" }).errors).toEqual([
        "releaseCommands: must be an array of strings",
      ]);
      expect(parseOpenshipConfig({ releaseCommands: ["ok", 7] }).errors).toEqual([
        "releaseCommands[1]: must be a string",
      ]);
    });

    // Absent must stay distinguishable from `[]` all the way to the column: the
    // phase is opt-in, and an undeclared field has to behave exactly as it did
    // before the field existed.
    it("is absent (not undefined-valued) when undeclared", () => {
      const { config, errors } = parseOpenshipConfig({ framework: "nextjs" });
      expect(errors).toEqual([]);
      expect(config && "releaseCommands" in config).toBe(false);
    });

    it("keeps an explicit empty list as a declared opt-out", () => {
      const { config, errors } = parseOpenshipConfig({ releaseCommands: [] });
      expect(errors).toEqual([]);
      expect(config?.releaseCommands).toEqual([]);
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

  describe("roles (#935)", () => {
    it("parses a valid worker role with health and replicas", () => {
      const { config, errors } = parseOpenshipConfig({
        roles: [
          {
            name: "jobs",
            kind: "worker",
            command: "bin/jobs",
            replicas: 2,
            health: { kind: "process" },
          },
        ],
      });
      expect(errors).toEqual([]);
      expect(config?.roles).toEqual([
        { name: "jobs", kind: "worker", command: "bin/jobs", replicas: 2, health: { kind: "process" } },
      ]);
    });

    it("an absent `roles` field parses byte-identical to a config with none declared", () => {
      const withoutRoles = parseOpenshipConfig({ framework: "rails" });
      expect(withoutRoles.config).not.toHaveProperty("roles");
      expect(withoutRoles.errors).toEqual([]);
    });

    it("roles: [] is a valid explicit opt-out", () => {
      const { config, errors } = parseOpenshipConfig({ roles: [] });
      expect(errors).toEqual([]);
      expect(config?.roles).toEqual([]);
    });

    it("rejects a role with kind: web - web is derived from startCommand", () => {
      const { errors, config } = parseOpenshipConfig({
        roles: [{ name: "web", kind: "web", command: "bin/rails server" }],
      });
      expect(errors.some((e) => e.startsWith("roles[0].kind"))).toBe(true);
      expect(config?.roles).toEqual([]);
    });

    it("rejects a role with an empty or missing name", () => {
      const { errors } = parseOpenshipConfig({
        roles: [{ kind: "worker", command: "bin/jobs" }, { name: "", kind: "worker", command: "bin/jobs" }],
      });
      expect(errors.filter((e) => e.includes("requires a non-empty `name`")).length).toBe(2);
    });

    it("rejects duplicate role names", () => {
      const { errors, config } = parseOpenshipConfig({
        roles: [
          { name: "jobs", kind: "worker", command: "bin/jobs" },
          { name: "jobs", kind: "worker", command: "bin/other" },
        ],
      });
      expect(errors.some((e) => e.includes('duplicates role "jobs"'))).toBe(true);
      expect(config?.roles).toEqual([{ name: "jobs", kind: "worker", command: "bin/jobs" }]);
    });

    it("rejects a missing or empty command", () => {
      const { errors } = parseOpenshipConfig({
        roles: [{ name: "jobs", kind: "worker", command: "" }],
      });
      expect(errors.some((e) => e.includes("requires a non-empty `command`"))).toBe(true);
    });

    it("rejects a non-integer or sub-1 replicas count", () => {
      const { errors: e1 } = parseOpenshipConfig({
        roles: [{ name: "jobs", kind: "worker", command: "bin/jobs", replicas: 1.5 }],
      });
      expect(e1.some((e) => e.includes("roles[0].replicas"))).toBe(true);

      const { errors: e2 } = parseOpenshipConfig({
        roles: [{ name: "jobs", kind: "worker", command: "bin/jobs", replicas: 0 }],
      });
      expect(e2.some((e) => e.includes("roles[0].replicas"))).toBe(true);
    });

    it("forces singleton true for a scheduler role regardless of what was declared", () => {
      const { config, errors } = parseOpenshipConfig({
        roles: [{ name: "cron", kind: "scheduler", command: "bin/cron", singleton: false }],
      });
      expect(errors).toEqual([]);
      expect(config?.roles?.[0]?.singleton).toBe(true);
    });

    it("rejects an unknown role kind and an unknown health kind", () => {
      const { errors } = parseOpenshipConfig({
        roles: [
          { name: "jobs", kind: "batch", command: "bin/jobs" },
          { name: "cron", kind: "scheduler", command: "bin/cron", health: { kind: "tcp" } },
        ],
      });
      expect(errors.some((e) => e.startsWith("roles[0].kind"))).toBe(true);
      expect(errors.some((e) => e.startsWith("roles[1].health.kind"))).toBe(true);
    });

    it("rejects `roles` that isn't an array", () => {
      const { errors } = parseOpenshipConfig({ roles: { name: "jobs" } });
      expect(errors.some((e) => e.startsWith("roles:"))).toBe(true);
    });
  });
});
