import { expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, createPublicEndpoint } from "./types";
import {
  persistRouteProtectionDrafts,
  clearRouteProtectionDrafts,
} from "./route-protection-drafts";
const save = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/api", () => ({ projectsApi: { changeRouteProtection: save } }));

it("persists passwords separately and clears only acknowledged drafts", async () => {
  const draft = {
    hostname: "private.test",
    action: "protect" as const,
    password: "private-wizard-password",
  };
  const endpoint = createPublicEndpoint({
    domainType: "custom",
    customDomain: draft.hostname,
    protectionDraft: draft,
  });
  const config = { ...DEFAULT_CONFIG, deployTarget: "local" as const, publicEndpoints: [endpoint] };
  const saved = await persistRouteProtectionDrafts("proj", config);
  expect(save).toHaveBeenCalledWith("proj", draft);
  expect(
    clearRouteProtectionDrafts(config, saved).publicEndpoints[0].protectionDraft,
  ).toBeUndefined();
  const newer = {
    ...config,
    publicEndpoints: [{ ...endpoint, protectionDraft: { ...draft, password: "a-newer-password" } }],
  };
  expect(
    clearRouteProtectionDrafts(newer, saved).publicEndpoints[0].protectionDraft?.password,
  ).toBe("a-newer-password");
});

it("blocks a changed hostname or unsupported target instead of silently publishing it", async () => {
  const draft = {
    hostname: "private.test",
    action: "protect" as const,
    password: "private-wizard-password",
  };
  const endpoint = createPublicEndpoint({
    domainType: "custom",
    customDomain: "changed.test",
    protectionDraft: draft,
  });
  save.mockClear();
  await expect(
    persistRouteProtectionDrafts("proj", { ...DEFAULT_CONFIG, publicEndpoints: [endpoint] }),
  ).rejects.toThrow(/hostname changed/);
  await expect(
    persistRouteProtectionDrafts("proj", {
      ...DEFAULT_CONFIG,
      deployTarget: "cloud",
      publicEndpoints: [{ ...endpoint, customDomain: draft.hostname }],
    }),
  ).rejects.toThrow(/self-hosted/);
  expect(save).not.toHaveBeenCalled();
});
