import { describe, expect, it } from "vitest";
import { getAppTemplate } from "../app-templates";

describe("Umami catalog security update", () => {
  it("uses the security-patched v3 PostgreSQL release", () => {
    const umami = getAppTemplate("umami");
    const image = umami?.services?.find((service) => service.name === "umami")?.image;
    // v3 dropped the `postgresql-` tag prefix and MySQL support. The catalog
    // already runs PostgreSQL and the container auto-applies Prisma migrations
    // on start, so the pinned v3 image is a reviewed major upgrade. Moving off
    // v3 needs a new migration review.
    const version = image?.match(/^ghcr\.io\/umami-software\/umami:3\.(\d+)\.(\d+)$/);
    expect(
      version,
      "Use an official patched v3 image; a major upgrade needs a migration review",
    ).toBeTruthy();
    const [, minor, patch] = version!;
    // v3.4.1 carries the Next.js 16.4.2 / React 19.3.1 security fixes.
    expect(Number(minor) > 4 || (Number(minor) === 4 && Number(patch) >= 1)).toBe(true);
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
