import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PORT } from "@repo/core";

vi.mock("@repo/db", () => ({
  repos: {
    wildcardDomain: {
      findByDefault: vi.fn().mockResolvedValue({
        id: "wd_1",
        domain: "*.apps.openship.test",
        apex: "apps.openship.test",
        isDefault: true,
      }),
      findById: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
  },
}));

import {
  normalizeWildcardInput,
  generateCollisionProofSubdomain,
} from "../../../src/modules/domains/wildcard-domain.service";

describe("Wildcard Domain Service & Normalization", () => {
  it("normalizes domains with or without leading wildcard", () => {
    expect(normalizeWildcardInput("*.apps.example.com")).toEqual({
      domain: "*.apps.example.com",
      apex: "apps.example.com",
    });

    expect(normalizeWildcardInput("apps.example.com")).toEqual({
      domain: "*.apps.example.com",
      apex: "apps.example.com",
    });

    expect(normalizeWildcardInput("  *.PREVIEW.Company.org  ")).toEqual({
      domain: "*.preview.company.org",
      apex: "preview.company.org",
    });
  });

  it("rejects invalid or empty domain inputs", () => {
    expect(() => normalizeWildcardInput("")).toThrow(/Domain is required/);
    expect(() => normalizeWildcardInput("   ")).toThrow(/Domain is required/);
    expect(() => normalizeWildcardInput("invalid domain")).toThrow(/not a valid domain name/);
    expect(() => normalizeWildcardInput("localhost")).toThrow(/not a valid domain name/);
  });

  it("generates collision-proof random subdomains", async () => {
    // With env.HOST_DOMAIN set as fallback:
    process.env.HOST_DOMAIN = "apps.openship.test";

    const sub1 = await generateCollisionProofSubdomain("frontend");
    const sub2 = await generateCollisionProofSubdomain("frontend");

    expect(sub1).toMatch(/^frontend-[a-f0-9]{6}\.apps\.openship\.test$/);
    expect(sub2).toMatch(/^frontend-[a-f0-9]{6}\.apps\.openship\.test$/);
    // Crucial: identical project slugs must NOT collide
    expect(sub1).not.toEqual(sub2);

    delete process.env.HOST_DOMAIN;
  });
});

describe("Standardized 7000-Series Ports", () => {
  it("defaults to 7000-series ports with 100-stride spacing", () => {
    expect(DEFAULT_PORT.dashboard).toBe(7000);
    expect(DEFAULT_PORT.api).toBe(7100);
    expect(DEFAULT_PORT.web).toBe(7200);
    expect(DEFAULT_PORT.saasDashboard).toBe(7300);
    expect(DEFAULT_PORT.saasApi).toBe(7400);
  });

  it("does not occupy common user dev ports (3000, 3001, 4000, 5000)", () => {
    const assignedPorts = Object.values(DEFAULT_PORT);
    expect(assignedPorts).not.toContain(3000);
    expect(assignedPorts).not.toContain(3001);
    expect(assignedPorts).not.toContain(4000);
    expect(assignedPorts).not.toContain(5000);
  });
});
