import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  CLOUD_MODE: false,
  GITLAB_BASE_URL: "https://gitlab.com",
}));

vi.mock("../../../src/config/env", () => ({ env: envMock }));

import {
  assertAllowedGitlabBaseUrl,
  configuredGitlabOrigin,
  normalizeGitlabBaseUrl,
  parseAllowedGitlabBaseUrl,
} from "../../../src/modules/gitlab/gitlab.http";

describe("normalizeGitlabBaseUrl", () => {
  it("accepts bare hosts and strips path", () => {
    expect(normalizeGitlabBaseUrl("gitlab.example.com/foo")).toBe(
      "https://gitlab.example.com",
    );
  });

  it("preserves http for self-hosted", () => {
    expect(normalizeGitlabBaseUrl("http://gitlab.internal")).toBe(
      "http://gitlab.internal",
    );
  });

  it("rejects empty / garbage", () => {
    expect(normalizeGitlabBaseUrl("")).toBeNull();
    expect(normalizeGitlabBaseUrl("not a url :")).toBeNull();
  });
});

describe("assertAllowedGitlabBaseUrl", () => {
  beforeEach(() => {
    envMock.CLOUD_MODE = false;
    envMock.GITLAB_BASE_URL = "https://gitlab.com";
  });

  afterEach(() => {
    envMock.CLOUD_MODE = false;
  });

  it("allows private http origins when not CLOUD_MODE", () => {
    expect(() =>
      assertAllowedGitlabBaseUrl("http://10.0.0.5"),
    ).not.toThrow();
  });

  it("refuses non-HTTPS in CLOUD_MODE", () => {
    envMock.CLOUD_MODE = true;
    expect(() => assertAllowedGitlabBaseUrl("http://gitlab.com")).toThrow(
      /HTTPS/i,
    );
  });

  it("refuses custom hosts in CLOUD_MODE (SSRF)", () => {
    envMock.CLOUD_MODE = true;
    expect(() =>
      assertAllowedGitlabBaseUrl("https://169.254.169.254"),
    ).toThrow(/not allowed/i);
    expect(() =>
      assertAllowedGitlabBaseUrl("https://evil.example.com"),
    ).toThrow(/not allowed/i);
  });

  it("allows the configured origin in CLOUD_MODE", () => {
    envMock.CLOUD_MODE = true;
    expect(() =>
      assertAllowedGitlabBaseUrl(configuredGitlabOrigin()),
    ).not.toThrow();
  });

  it("parseAllowedGitlabBaseUrl returns null on empty, throws on SSRF", () => {
    envMock.CLOUD_MODE = true;
    expect(parseAllowedGitlabBaseUrl("")).toBeNull();
    expect(() => parseAllowedGitlabBaseUrl("https://evil.test")).toThrow();
    expect(parseAllowedGitlabBaseUrl("https://gitlab.com")).toBe(
      "https://gitlab.com",
    );
  });
});
