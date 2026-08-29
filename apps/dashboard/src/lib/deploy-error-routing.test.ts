import { describe, expect, it } from "vitest";
import { CLOUD_CAPABILITY_KEYS, cloudRequiredCode } from "@repo/core";

import { deployErrorCloudCapability, shouldPromptCloudConnect } from "./deploy-error-routing";

/**
 * The rule these pin: if no modal opens, the error gets toasted.
 *
 * The regression they exist for — a compose deploy answered
 * `403 CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS` ("Free subdomain
 * project-api.opsh.io requires Openship Cloud") showed the user NOTHING. Not a
 * toast, not a modal. `requireCloud` returns `true` immediately when the dashboard
 * already believes it is connected, so the caller's `if (!connected) showToast(...)`
 * read that short-circuit as "the user fixed it" and skipped the toast. The button
 * just reset, and the reason was in the network tab only.
 */

const CLOUD_CODE = "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS";

describe("shouldPromptCloudConnect", () => {
  it("prompts when connecting really is the missing step", () => {
    expect(
      shouldPromptCloudConnect({
        errorCode: CLOUD_CODE,
        canConnectCloud: true,
        cloudConnected: false,
      }),
    ).toBe(true);
  });

  it("does NOT prompt when we already think we're connected — the server disagreeing must be said out loud", () => {
    // The swallowed case. A modal here would open, resolve true instantly, and ask
    // nothing; returning false sends the caller to the toast, which is the only
    // thing that actually informs the user.
    expect(
      shouldPromptCloudConnect({
        errorCode: CLOUD_CODE,
        canConnectCloud: true,
        cloudConnected: true,
      }),
    ).toBe(false);
  });

  it("does not prompt on a platform that can't hold a cloud connection", () => {
    // SaaS has cloud natively; a connect modal is meaningless there.
    expect(
      shouldPromptCloudConnect({
        errorCode: CLOUD_CODE,
        canConnectCloud: false,
        cloudConnected: true,
      }),
    ).toBe(false);
    expect(
      shouldPromptCloudConnect({
        errorCode: CLOUD_CODE,
        canConnectCloud: false,
        cloudConnected: false,
      }),
    ).toBe(false);
  });

  it("does not prompt for a non-cloud error, so it falls through to the credential modal / toast", () => {
    for (const errorCode of [
      "GITHUB_TOKEN_REQUIRED",
      "SOMETHING_ELSE",
      null,
      undefined,
      "",
    ]) {
      expect(
        shouldPromptCloudConnect({ errorCode, canConnectCloud: true, cloudConnected: false }),
      ).toBe(false);
    }
  });

  it("routes every capability in the shared registry, not just the compose one", () => {
    // Driven off the registry itself, so a capability added server-side routes here
    // without a client change — and a renamed code fails here instead of silently
    // falling through to a bare toast.
    for (const capability of CLOUD_CAPABILITY_KEYS) {
      expect(
        shouldPromptCloudConnect({
          errorCode: cloudRequiredCode(capability),
          canConnectCloud: true,
          cloudConnected: false,
        }),
      ).toBe(true);
    }
  });
});

describe("deployErrorCloudCapability", () => {
  it("resolves the capability the modal's copy is keyed on", () => {
    expect(deployErrorCloudCapability(CLOUD_CODE)).toBe("managed-compose-domains");
  });

  it("is null for anything that isn't a cloud requirement", () => {
    expect(deployErrorCloudCapability("GITHUB_TOKEN_REQUIRED")).toBeNull();
    expect(deployErrorCloudCapability(null)).toBeNull();
  });
});
