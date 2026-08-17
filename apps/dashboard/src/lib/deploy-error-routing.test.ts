import { describe, expect, it } from "vitest";

import { deployErrorCloudCapability, shouldPromptCloudConnect } from "./deploy-error-routing";

describe("shouldPromptCloudConnect", () => {
  it("never prompts — Operator has no Cloud connect flow", () => {
    expect(
      shouldPromptCloudConnect({
        errorCode: "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS",
        canConnectCloud: true,
        cloudConnected: false,
      }),
    ).toBe(false);
  });
});

describe("deployErrorCloudCapability", () => {
  it("is always null", () => {
    expect(deployErrorCloudCapability("CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS")).toBeNull();
    expect(deployErrorCloudCapability("GITHUB_TOKEN_REQUIRED")).toBeNull();
    expect(deployErrorCloudCapability(null)).toBeNull();
  });
});
