/**
 * Webmail persistence invariant.
 *
 * The webmail image writes its session DB and branding under one dir it declares
 * as a VOLUME. Every redeploy is a new container off a new image, which is
 * exactly when an undeclared path disappears — and silently, because the
 * container runs as root: the writes succeed inside the container and vanish
 * with it, signing every user out and dropping settings, templates and the
 * sign-in audit log. Nothing else in the pipeline can notice, hence this test.
 *
 * Two artifacts have to agree and neither imports the other:
 *   apps/email/Dockerfile.webmail  → SQLITE_PATH / BRANDING_PATH
 *   catalog/webmail.json           → services[].volumes
 *
 * So the Dockerfile is read as text, and the chain the declared volume actually
 * travels is walked for real:
 *   catalog volumes → resolveProjectVolumes → scopeVolumeBinds → binds
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { getAppTemplate, resolveProjectVolumes } from "@repo/core";
import { scopeVolumeBinds } from "@repo/adapters";

const DOCKERFILE = readFileSync(
  fileURLToPath(new URL("../../../../email/Dockerfile.webmail", import.meta.url)),
  "utf8",
);

/** `ENV` values the image bakes in — the paths Zero actually writes to. */
function bakedPath(key: string): string {
  const match = DOCKERFILE.match(new RegExp(`\\b${key}=(\\S+)`));
  if (!match) throw new Error(`Dockerfile.webmail no longer sets ${key}`);
  return match[1];
}

const template = getAppTemplate("webmail");
const service = template?.services?.find((s) => s.name === "webmail");

/** The container-side mount points the catalog declares for the webmail service. */
function declaredMountPoints(): string[] {
  return (service?.volumes ?? []).map((v) => v.split(":")[1]).filter(Boolean);
}

/** What the deployment ends up handing docker for one project slug. */
function bindsFor(slug: string): string[] {
  const declared = resolveProjectVolumes(service?.volumes ?? [], "webmail");
  return scopeVolumeBinds(slug, declared, true);
}

describe("webmail persistent state", () => {
  const slug = "webmail-example-com";

  it("declares a volume in the catalog at all", () => {
    expect(service, "webmail app missing from the catalog").toBeDefined();
    expect(declaredMountPoints().length).toBeGreaterThan(0);
  });

  it("covers both paths the image writes", () => {
    const mounts = declaredMountPoints();
    for (const key of ["SQLITE_PATH", "BRANDING_PATH"]) {
      const path = bakedPath(key);
      const covered = mounts.some((m) => path === m || path.startsWith(`${m}/`));
      expect(covered, `${key}=${path} is not inside any declared volume`).toBe(true);
    }
  });

  it("survives namespacing as this project's own volume", () => {
    // scopeVolumeBinds rewrites a NAMED source to `openship-<slug>-<name>`, which
    // is what keeps two webmails on one host off each other's zero.db. A bind
    // that came out unscoped would be shared state.
    const binds = bindsFor(slug);
    expect(binds.length).toBe(declaredMountPoints().length);
    for (const bind of binds) {
      expect(bind.startsWith(`openship-${slug}-`)).toBe(true);
    }
  });

  it("gives each webmail on a server its own volume", () => {
    expect(bindsFor("webmail-example-com")).not.toEqual(bindsFor("webmail-other-com"));
  });
});
