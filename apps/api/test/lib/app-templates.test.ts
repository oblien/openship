import { describe, expect, it } from "vitest";
import { APP_TEMPLATES, getAppTemplate } from "@repo/core";

describe("app catalog", () => {
  it("has no legacy/marketing entries (no WordPress)", () => {
    const ids = APP_TEMPLATES.map((t) => t.id);
    expect(ids).not.toContain("wordpress");
  });

  it("surfaces Mail as a first-class flow app (hands off to the mail provider wizard)", () => {
    // v0.2.2: Mail is a catalog "flow" app that routes to /apps/new/mail
    // (the mail-provider wizard), not a compose template deployed only via
    // /emails. Every OTHER catalog app is still a compose "template".
    const mail = getAppTemplate("mail");
    expect(mail).toBeDefined();
    expect(mail!.kind).toBe("flow");
    expect(mail!.flowHref).toBe("/apps/new/mail");
    expect(APP_TEMPLATES.filter((t) => t.id !== "mail").every((t) => t.kind === "template")).toBe(true);
  });

  it("includes Convex + n8n", () => {
    expect(getAppTemplate("convex")).toBeDefined();
    expect(getAppTemplate("n8n")).toBeDefined();
  });

  it("Convex exposes the backend on 3210 and persists a data volume", () => {
    const convex = getAppTemplate("convex")!;
    const backend = convex.services!.find((s) => s.name === "backend")!;
    expect(backend.image).toContain("convex-backend");
    expect(backend.exposedPort).toBe(3210);
    expect(backend.exposed).toBe(true);
    expect(backend.volumes).toContain("convex_data:/convex/data");
    // INSTANCE_SECRET is a generated secret, not a plaintext default.
    expect(backend.secretEnv).toContain("INSTANCE_SECRET");
    expect(backend.environment).not.toHaveProperty("INSTANCE_SECRET");
  });

  it("n8n persists to a volume and generates an encryption key", () => {
    const n8n = getAppTemplate("n8n")!;
    const svc = n8n.services!.find((s) => s.name === "n8n")!;
    expect(svc.volumes).toContain("n8n_data:/home/node/.n8n");
    expect(n8n.configFields?.some((f) => f.key === "N8N_ENCRYPTION_KEY" && f.generate === "secret")).toBe(true);
  });

  it("adds Kan.bn with its migration job, Postgres database, and web app", () => {
    const kanbn = getAppTemplate("kanbn")!;
    expect(kanbn.repository).toBe("https://github.com/kanbn/kan");
    expect(kanbn.endpoints).toEqual([
      { service: "web", port: 3000, label: "Kan.bn", kind: "http" },
    ]);

    const postgres = kanbn.services!.find((s) => s.name === "postgres")!;
    expect(postgres.image).toBe("postgres:15");
    expect(postgres.volumes).toContain("kan_postgres_data:/var/lib/postgresql/data");
    expect(postgres.secretEnv).toContain("POSTGRES_PASSWORD");
    expect(postgres.healthcheck?.test).toEqual(["CMD-SHELL", "pg_isready -U kan -d kan_db"]);

    const migrate = kanbn.services!.find((s) => s.name === "migrate")!;
    expect(migrate.image).toBe("ghcr.io/kanbn/kan-migrate:latest");
    expect(migrate.dependsOn).toEqual(["postgres"]);

    const web = kanbn.services!.find((s) => s.name === "web")!;
    expect(web.image).toBe("ghcr.io/kanbn/kan:latest");
    expect(web.dependsOn).toEqual(["migrate"]);
    expect(web.exposedPort).toBe(3000);
    expect(web.environment).toMatchObject({
      NEXT_PUBLIC_BASE_URL: "{{publicUrl:web}}",
      NEXT_PUBLIC_ALLOW_CREDENTIALS: "true",
    });
    expect(web.secretEnv).toEqual(["POSTGRES_URL", "BETTER_AUTH_SECRET"]);
    expect(
      kanbn.configFields?.some((f) => f.key === "POSTGRES_PASSWORD" && f.generate === "secret"),
    ).toBe(true);
    expect(
      kanbn.configFields?.some((f) => f.key === "BETTER_AUTH_SECRET" && f.generate === "secret"),
    ).toBe(true);
  });
});
