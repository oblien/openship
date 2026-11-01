import { describe, expect, it } from "vitest";
import { APP_TEMPLATES, getAppTemplate } from "@repo/core";

describe("app catalog", () => {
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
});
