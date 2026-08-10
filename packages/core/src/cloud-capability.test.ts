import { describe, it, expect } from "vitest";
import {
  CLOUD_CAPABILITIES,
  CLOUD_CAPABILITY_KEYS,
  CLOUD_UNREACHABLE_CODE,
  cloudRequiredCode,
  parseCloudRequiredCode,
  endpointNeedsCloud,
  endpointsNeedCloud,
  servicesNeedCloud,
  type CloudCapability,
} from "./cloud-capability";

describe("cloud-capability registry", () => {
  it("every capability has a non-empty code + valid HTTP status", () => {
    for (const cap of CLOUD_CAPABILITY_KEYS) {
      const meta = CLOUD_CAPABILITIES[cap];
      expect(meta.code.length).toBeGreaterThan(0);
      expect(meta.httpStatus).toBeGreaterThanOrEqual(400);
      expect(meta.httpStatus).toBeLessThan(600);
    }
  });

  it("codes are unique across capabilities and distinct from CLOUD_UNREACHABLE", () => {
    const codes = CLOUD_CAPABILITY_KEYS.map((c) => CLOUD_CAPABILITIES[c].code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(CLOUD_UNREACHABLE_CODE);
  });

  it("preserves the existing wire codes (no breaking rename)", () => {
    // These strings are the contract existing clients already match on.
    expect(cloudRequiredCode("cloud-deploy-target")).toBe("CLOUD_REQUIRED_TARGET");
    expect(cloudRequiredCode("managed-project-domain")).toBe("CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN");
    expect(cloudRequiredCode("managed-compose-domains")).toBe("CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS");
    expect(cloudRequiredCode("billing")).toBe("cloud_not_connected");
    expect(cloudRequiredCode("migrate-to-cloud")).toBe("MIGRATE_TO_CLOUD_NOT_CONNECTED");
  });

  it("cloudRequiredCode ↔ parseCloudRequiredCode round-trips for every capability", () => {
    for (const cap of CLOUD_CAPABILITY_KEYS) {
      expect(parseCloudRequiredCode(cloudRequiredCode(cap))).toBe(cap as CloudCapability);
    }
  });

  it("parseCloudRequiredCode ignores unknown / unreachable / empty codes", () => {
    expect(parseCloudRequiredCode(CLOUD_UNREACHABLE_CODE)).toBeNull();
    expect(parseCloudRequiredCode("NOPE")).toBeNull();
    expect(parseCloudRequiredCode(null)).toBeNull();
    expect(parseCloudRequiredCode(undefined)).toBeNull();
  });
});

describe("needs-cloud predicate", () => {
  it("endpointNeedsCloud: only an explicit 'custom' domain type is self-hostable", () => {
    expect(endpointNeedsCloud("custom")).toBe(false);
    expect(endpointNeedsCloud("free")).toBe(true);
    expect(endpointNeedsCloud(null)).toBe(true);
    expect(endpointNeedsCloud(undefined)).toBe(true);
  });

  it("endpointsNeedCloud: true if ANY endpoint is non-custom; false for empty/all-custom", () => {
    expect(endpointsNeedCloud(undefined)).toBe(false);
    expect(endpointsNeedCloud([])).toBe(false);
    expect(endpointsNeedCloud([{ domainType: "custom" }])).toBe(false);
    expect(endpointsNeedCloud([{ domainType: "custom" }, { domainType: "free" }])).toBe(true);
  });

  it("servicesNeedCloud: only EXPOSED non-custom services need cloud", () => {
    expect(servicesNeedCloud(undefined)).toBe(false);
    expect(servicesNeedCloud([{ exposed: false, domainType: "free" }])).toBe(false);
    expect(servicesNeedCloud([{ exposed: true, domainType: "custom" }])).toBe(false);
    expect(servicesNeedCloud([{ exposed: true, domainType: "free" }])).toBe(true);
    expect(
      servicesNeedCloud([
        { exposed: true, domainType: "custom" },
        { exposed: true, domainType: "free" },
      ]),
    ).toBe(true);
  });
});
