import { describe, expect, it } from "vitest";
import {
  OPERATOR_FEATURES,
  featuresForEdition,
  parseCloudModeFlag,
  resolveEdition,
  resolveEditionState,
} from "./edition";

describe("edition", () => {
  it("is operator regardless of the CLOUD_MODE flag", () => {
    expect(resolveEdition({ cloudMode: true })).toBe("operator");
    expect(resolveEdition({ cloudMode: false })).toBe("operator");
    expect(resolveEdition()).toBe("operator");
  });

  it("turns off every SaaS surface", () => {
    expect(featuresForEdition("operator")).toEqual({
      billing: false,
      cloudConnect: false,
      publicSignup: false,
      hostedGithubApp: false,
      cloudDeploy: false,
    });
    expect(featuresForEdition()).toEqual(OPERATOR_FEATURES);
  });

  it("resolveEditionState is always operator", () => {
    expect(resolveEditionState({ cloudMode: false })).toEqual({
      edition: "operator",
      features: OPERATOR_FEATURES,
    });
    expect(resolveEditionState({ cloudMode: true })).toEqual({
      edition: "operator",
      features: OPERATOR_FEATURES,
    });
  });

  it("parseCloudModeFlag accepts the same truthy forms as the API env parser", () => {
    expect(parseCloudModeFlag(true)).toBe(true);
    expect(parseCloudModeFlag("true")).toBe(true);
    expect(parseCloudModeFlag("1")).toBe(true);
    expect(parseCloudModeFlag(false)).toBe(false);
    expect(parseCloudModeFlag("false")).toBe(false);
    expect(parseCloudModeFlag("0")).toBe(false);
    expect(parseCloudModeFlag(undefined)).toBe(false);
    expect(parseCloudModeFlag("")).toBe(false);
  });
});
