import { describe, expect, it } from "vitest";
import {
  CLOUD_FEATURES,
  OPERATOR_FEATURES,
  featuresForEdition,
  parseCloudModeFlag,
  resolveEdition,
  resolveEditionState,
} from "./edition";

describe("edition", () => {
  it("maps CLOUD_MODE true → cloud and everything else → operator", () => {
    expect(resolveEdition({ cloudMode: true })).toBe("cloud");
    expect(resolveEdition({ cloudMode: false })).toBe("operator");
  });

  it("turns off every SaaS surface on operator", () => {
    expect(featuresForEdition("operator")).toEqual({
      billing: false,
      cloudConnect: false,
      publicSignup: false,
      hostedGithubApp: false,
      cloudDeploy: false,
    });
    expect(featuresForEdition("operator")).toEqual(OPERATOR_FEATURES);
  });

  it("keeps every SaaS surface on for cloud", () => {
    expect(featuresForEdition("cloud")).toEqual({
      billing: true,
      cloudConnect: true,
      publicSignup: true,
      hostedGithubApp: true,
      cloudDeploy: true,
    });
    expect(featuresForEdition("cloud")).toEqual(CLOUD_FEATURES);
  });

  it("resolveEditionState pairs edition with its feature map", () => {
    expect(resolveEditionState({ cloudMode: false })).toEqual({
      edition: "operator",
      features: OPERATOR_FEATURES,
    });
    expect(resolveEditionState({ cloudMode: true })).toEqual({
      edition: "cloud",
      features: CLOUD_FEATURES,
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
