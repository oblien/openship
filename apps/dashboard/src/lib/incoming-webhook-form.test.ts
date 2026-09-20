import { describe, expect, it } from "vitest";
import {
  canSubmitIncomingWebhook,
  incomingWebhookTargetIds,
  toggleIncomingWebhookServiceTarget,
} from "./incoming-webhook-form";

describe("incoming webhook form scope safety", () => {
  it("requires an explicit all-services choice before broadening a narrowed scope", () => {
    expect(toggleIncomingWebhookServiceTarget(null, "svc-api")).toEqual(["svc-api"]);
    expect(toggleIncomingWebhookServiceTarget(["svc-api"], "svc-api")).toEqual(["svc-api"]);
    expect(toggleIncomingWebhookServiceTarget(["svc-api"], "svc-worker")).toEqual([
      "svc-api",
      "svc-worker",
    ]);
    expect(toggleIncomingWebhookServiceTarget(["svc-api", "svc-worker"], "svc-api")).toEqual([
      "svc-worker",
    ]);
  });

  it("does not submit a deploy while service choices are loading or failed", () => {
    const base = {
      name: "CI deploy",
      actionType: "deploy" as const,
      jobKey: "",
      busy: false,
    };

    expect(canSubmitIncomingWebhook({ ...base, serviceOptionsState: "loading" })).toBe(false);
    expect(canSubmitIncomingWebhook({ ...base, serviceOptionsState: "error" })).toBe(false);
    expect(canSubmitIncomingWebhook({ ...base, serviceOptionsState: "ready" })).toBe(true);
  });

  it("keeps job submission independent from the service lookup", () => {
    expect(
      canSubmitIncomingWebhook({
        name: "Nightly backup",
        actionType: "job",
        jobKey: "backup:run",
        busy: false,
        serviceOptionsState: "error",
      }),
    ).toBe(true);
  });

  it("returns every scoped target identity for row auditability", () => {
    expect(incomingWebhookTargetIds({ serviceIds: ["svc-api", "svc-worker"] })).toEqual([
      "svc-api",
      "svc-worker",
    ]);
    expect(incomingWebhookTargetIds({ serviceId: "svc-legacy" })).toEqual(["svc-legacy"]);
    expect(incomingWebhookTargetIds({})).toEqual([]);
  });
});
