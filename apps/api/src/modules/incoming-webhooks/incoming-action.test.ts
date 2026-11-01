import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { CreateIncomingWebhookBody, UpdateIncomingWebhookBody } from "@repo/contracts";
import { deployServiceIds, normalizeDeployActionConfig } from "@repo/platform/engine/modules/incoming-webhooks/incoming-action";

describe("incoming webhook deploy targets", () => {
  it("prefers and canonicalizes plural service ids", () => {
    expect(
      deployServiceIds({ serviceId: "legacy", serviceIds: [" svc_api ", "svc_worker"] }),
    ).toEqual(["svc_api", "svc_worker"]);
    expect(
      normalizeDeployActionConfig({
        serviceId: "legacy",
        serviceIds: [" svc_api ", "svc_worker"],
      }),
    ).toEqual({ serviceIds: ["svc_api", "svc_worker"] });
  });

  it("keeps legacy single-service webhook rows working", () => {
    expect(deployServiceIds({ serviceId: "svc_api" })).toEqual(["svc_api"]);
    expect(deployServiceIds({})).toBeUndefined();
  });

  it("preserves legacy empty serviceId rows as whole-project hooks", () => {
    expect(deployServiceIds({ serviceId: "" })).toBeUndefined();
    expect(normalizeDeployActionConfig({ serviceId: "" })).toEqual({});

    // Compatibility is dispatch-only: newly submitted blank targets remain
    // invalid at both management API boundaries.
    expect(
      Value.Check(CreateIncomingWebhookBody, {
        actionType: "deploy",
        actionConfig: { serviceId: "" },
      }),
    ).toBe(false);
    expect(Value.Check(UpdateIncomingWebhookBody, { actionConfig: { serviceId: "" } })).toBe(false);
  });

  it("drops configuration belonging to a previous job action", () => {
    expect(normalizeDeployActionConfig({ jobKey: "backup:run" })).toEqual({});
  });

  it("accepts plural targets on create and update", () => {
    const actionConfig = { serviceIds: ["svc_api", "svc_worker"] };
    expect(Value.Check(CreateIncomingWebhookBody, { actionType: "deploy", actionConfig })).toBe(
      true,
    );
    expect(Value.Check(UpdateIncomingWebhookBody, { actionConfig })).toBe(true);
  });

  it("rejects malformed target arrays at the schema boundary", () => {
    for (const serviceIds of [[], ["svc_api", "svc_api"], ["svc_api", 2], ["   "]]) {
      expect(
        Value.Check(CreateIncomingWebhookBody, {
          actionType: "deploy",
          actionConfig: { serviceIds },
        }),
      ).toBe(false);
    }
  });

  it("fails closed on blank or post-trim duplicate targets", () => {
    expect(() => deployServiceIds({ serviceIds: ["svc_api", " svc_api "] })).toThrow(/duplicate/);
    expect(() => deployServiceIds({ serviceIds: ["svc_api", " "] })).toThrow(/non-empty/);
    expect(() => deployServiceIds({ serviceId: " " })).toThrow(/non-empty/);
  });
});
