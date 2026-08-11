import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMailImageRef } from "./mail-image-ref";
import { DEFAULT_IMAGE_REGISTRY } from "./constants";

const ENV_KEYS = [
  "OPENSHIP_MAIL_IMAGE",
  "OPENSHIP_MAIL_TAG",
  "OPENSHIP_VERSION",
  "OPENSHIP_IMAGE_REGISTRY",
] as const;

describe("buildMailImageRef", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prefers an explicit ref over everything", () => {
    process.env.OPENSHIP_MAIL_IMAGE = "env/should-not-win:x";
    expect(buildMailImageRef({ explicit: "explicit/wins:1", injectedDefault: "inj:1" })).toBe(
      "explicit/wins:1",
    );
  });

  it("uses OPENSHIP_MAIL_IMAGE over the injected default", () => {
    process.env.OPENSHIP_MAIL_IMAGE = "env/wins:2";
    expect(buildMailImageRef({ injectedDefault: "inj:2" })).toBe("env/wins:2");
  });

  it("uses the injected default over the constructed ref", () => {
    expect(buildMailImageRef({ injectedDefault: "inj/wins:3" })).toBe("inj/wins:3");
  });

  it("constructs from registry + OPENSHIP_MAIL_TAG (ahead of OPENSHIP_VERSION)", () => {
    process.env.OPENSHIP_MAIL_TAG = "1.2.3";
    process.env.OPENSHIP_VERSION = "9.9.9";
    expect(buildMailImageRef()).toBe(`${DEFAULT_IMAGE_REGISTRY}/openship-mail:1.2.3`);
  });

  it("falls back to OPENSHIP_VERSION, then fallbackTag, then latest", () => {
    process.env.OPENSHIP_VERSION = "0.5.0";
    expect(buildMailImageRef({ fallbackTag: "app-v" })).toBe(
      `${DEFAULT_IMAGE_REGISTRY}/openship-mail:0.5.0`,
    );

    delete process.env.OPENSHIP_VERSION;
    expect(buildMailImageRef({ fallbackTag: "app-v" })).toBe(
      `${DEFAULT_IMAGE_REGISTRY}/openship-mail:app-v`,
    );
    expect(buildMailImageRef()).toBe(`${DEFAULT_IMAGE_REGISTRY}/openship-mail:latest`);
  });

  it("honors a custom registry", () => {
    process.env.OPENSHIP_IMAGE_REGISTRY = "registry.example.com/team";
    process.env.OPENSHIP_MAIL_TAG = "edge";
    expect(buildMailImageRef()).toBe("registry.example.com/team/openship-mail:edge");
  });
});
