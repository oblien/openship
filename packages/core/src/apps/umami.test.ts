import { describe, expect, it } from "vitest";
import { getAppTemplate } from "../app-templates";

describe("Umami catalog security update", () => {
  it("uses the security-patched v2 PostgreSQL release", () => {
    const umami = getAppTemplate("umami");
    const image = umami?.services?.find((service) => service.name === "umami")?.image;
    const version = image?.match(/^ghcr\.io\/umami-software\/umami:postgresql-v2\.(\d+)\.(\d+)$/);
    expect(
      version,
      "Use an official patched v2 image; a major upgrade needs a migration review",
    ).toBeTruthy();
    const [, minor, patch] = version!;
    // v2.20.2 carries the Next.js / React Server Components security fixes.
    expect(Number(minor) > 20 || (Number(minor) === 20 && Number(patch) >= 2)).toBe(true);
  });

  it("preserves the existing database, volume, and generated secret contract", () => {
    const umami = getAppTemplate("umami")!;
    const app = umami.services!.find((service) => service.name === "umami")!;
    const database = umami.services!.find((service) => service.name === "umami-db")!;
    expect(app).toMatchObject({
      exposedPort: 3000,
      dependsOn: ["umami-db"],
      environment: {
        DATABASE_TYPE: "postgresql",
        DATABASE_URL: "postgresql://umami:{{config:POSTGRES_PASSWORD}}@umami-db:5432/umami",
      },
      secretEnv: ["DATABASE_URL"],
    });
    expect(database).toMatchObject({
      image: "postgres:16-alpine",
      environment: { POSTGRES_DB: "umami", POSTGRES_USER: "umami" },
      secretEnv: ["POSTGRES_PASSWORD"],
      volumes: ["umami_db:/var/lib/postgresql/data"],
    });
    expect(umami.configFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "POSTGRES_PASSWORD",
          service: "umami-db",
          generate: "secret",
          secret: true,
        }),
        expect.objectContaining({
          key: "APP_SECRET",
          service: "umami",
          generate: "secret",
          secret: true,
        }),
      ]),
    );
  });
});
