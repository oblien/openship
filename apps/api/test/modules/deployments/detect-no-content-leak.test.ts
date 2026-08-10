import { describe, it, expect } from "vitest";
import { projectInfoToScanResponse } from "../../../src/modules/deployments/prepare.service";

/**
 * `/github/repos/:owner/:repo/detect` sits at METADATA tier — it is what makes
 * deploy-only access usable, so a caller with no content grant can call it. That is
 * only safe while its payload carries CONCLUSIONS and never file bytes.
 *
 * The danger is specific: the resolver behind it reads `.env` and
 * `docker-compose.yml` server-side, and those files routinely hold secrets. If a
 * value from them reached the response, detect would become a content
 * side-channel — a way to read the exact material the content gate exists to
 * protect, from a grant that was never given content access.
 *
 * So this asserts at the VALUE level: plant sentinels in every env-bearing field
 * and prove none of them appear anywhere in the serialised output. A key-level
 * allowlist would miss a value copied into a new field; scanning the whole JSON
 * does not.
 */

const SENTINELS = {
  rootEnv: "ROOT_ENV_SECRET_a1b2c3",
  serviceEnv: "SERVICE_ENV_SECRET_d4e5f6",
  secondService: "SECOND_SERVICE_SECRET_g7h8i9",
};

/** A ProjectInfo carrying secrets in every env-shaped field the resolver fills. */
function infoWithSecrets() {
  return {
    repository: {
      name: "charts",
      full_name: "hydralerne/charts",
      owner: { login: "hydralerne" },
      private: true,
      default_branch: "main",
    },
    stack: "vite",
    projectType: "app",
    category: "frontend",
    packageManager: "npm",
    buildCommand: "npm run build",
    installCommand: "npm install",
    startCommand: "",
    buildImage: "node:22",
    outputDirectory: "dist",
    rootDirectory: "./",
    productionPaths: ["dist"],
    port: 3000,
    rootEnv: { DATABASE_URL: SENTINELS.rootEnv, PUBLIC_NAME: "fine" },
    services: [
      {
        name: "api",
        image: "node:22",
        ports: ["3000:3000"],
        dependsOn: [],
        volumes: [],
        environment: { STRIPE_SECRET: SENTINELS.serviceEnv },
      },
      {
        name: "db",
        image: "postgres:16",
        ports: [],
        dependsOn: [],
        volumes: [],
        environment: { POSTGRES_PASSWORD: SENTINELS.secondService },
      },
    ],
  } as unknown as Parameters<typeof projectInfoToScanResponse>[0];
}

describe("detect cannot leak file content through env values", () => {
  it("masks every planted secret, in every env-bearing field", () => {
    const serialised = JSON.stringify(projectInfoToScanResponse(infoWithSecrets()));
    for (const [field, secret] of Object.entries(SENTINELS)) {
      expect(
        serialised.includes(secret),
        `${field}: a value read from the repo reached the detect payload — detect is ` +
          `metadata tier, so this is a content side-channel`,
      ).toBe(false);
    }
  });

  it("masks EVERY service, not just the first", () => {
    // A mapper that masked services[0] and passed the rest through would satisfy a
    // single-service fixture. Two services with distinct secrets catches it.
    const out = projectInfoToScanResponse(infoWithSecrets());
    const services = (out as { services?: Array<{ environment?: Record<string, string> }> }).services;
    expect(services).toHaveLength(2);
    for (const svc of services ?? []) {
      for (const value of Object.values(svc.environment ?? {})) {
        expect(Object.values(SENTINELS)).not.toContain(value);
      }
    }
  });

  it("still returns the derived config an agent needs to configure a deploy", () => {
    // The masking must not be so blunt that deploy-only becomes useless — the
    // whole point of detect is that these fields survive.
    const out = projectInfoToScanResponse(infoWithSecrets()) as Record<string, unknown>;
    expect(out.stack).toBe("vite");
    expect(out.packageManager).toBe("npm");
    expect(out.buildCommand).toBe("npm run build");
    expect(out.installCommand).toBe("npm install");
    expect(out.outputDirectory).toBe("dist");
    expect(out.port).toBe(3000);
    // Service NAMES and images are config, not content — the wizard needs them.
    const services = out.services as Array<{ name: string; image?: string }>;
    expect(services.map((s) => s.name)).toEqual(["api", "db"]);
  });

  it("keeps env KEYS while dropping their values", () => {
    // Knowing DATABASE_URL is required is config the wizard must show; knowing its
    // value is the secret. Asserted so a future change can't silently start
    // emitting values while still "passing" a key-shape test.
    const out = projectInfoToScanResponse(infoWithSecrets()) as {
      rootEnv?: Record<string, string>;
    };
    if (out.rootEnv) {
      expect(Object.keys(out.rootEnv)).toContain("DATABASE_URL");
      expect(out.rootEnv.DATABASE_URL).not.toBe(SENTINELS.rootEnv);
    }
  });
});
