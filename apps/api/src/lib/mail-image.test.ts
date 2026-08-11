import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import { APP_VERSION } from "./app-version";
import { mailBuildSpec, pinnedMailImage } from "./mail-image";

const MAIL_DOCKERFILE = join("apps", "email", "Dockerfile");
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function clearRefEnv() {
  delete process.env.OPENSHIP_MAIL_IMAGE;
  delete process.env.OPENSHIP_MAIL_TAG;
  delete process.env.OPENSHIP_VERSION;
  delete process.env.OPENSHIP_IMAGE_REGISTRY;
}

describe("mailBuildSpec", () => {
  it("returns the explicit OPENSHIP_MAIL_BUILD_CONTEXT (with the dockerfile) when set", () => {
    process.env.OPENSHIP_MAIL_BUILD_CONTEXT = "/srv/openship-checkout";
    expect(mailBuildSpec()).toEqual({ context: "/srv/openship-checkout", dockerfile: MAIL_DOCKERFILE });
  });

  it("auto-detects a repo root that actually holds apps/email/Dockerfile", () => {
    delete process.env.OPENSHIP_MAIL_BUILD_CONTEXT;
    const spec = mailBuildSpec();
    // Running from a source checkout, so the anchor above apps/api IS the repo root.
    // Assert the context is a real dir holding the Dockerfile rather than hardcoding a
    // path — the guard is what keeps a bundled install from returning a bogus context.
    expect(spec).toBeDefined();
    expect(existsSync(join(spec!.context, "apps", "email", "Dockerfile"))).toBe(true);
  });
});

describe("pinnedMailImage — virtual dev version", () => {
  it("suffixes the tag with a content hash when a source checkout is present", () => {
    clearRefEnv();
    delete process.env.OPENSHIP_MAIL_BUILD_CONTEXT; // auto-detect the real repo root
    const pattern = new RegExp(`:${APP_VERSION.replace(/\./g, "\\.")}-dev\\.[0-9a-f]{12}$`);
    expect(pinnedMailImage()).toMatch(pattern);
  });

  it("falls back to the plain published version when the checkout holds no engine tree", () => {
    clearRefEnv();
    // Explicit context is taken verbatim (no existence check), but it holds no
    // apps/email tree, so the dev-tag signature is empty and the tag stays APP_VERSION.
    process.env.OPENSHIP_MAIL_BUILD_CONTEXT = "/definitely/not/an/openship/checkout";
    expect(pinnedMailImage()).toBe(`ghcr.io/oblien/openship-mail:${APP_VERSION}`);
  });
});
