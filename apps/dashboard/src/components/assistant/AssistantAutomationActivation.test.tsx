// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AssistantNavigationContext } from "./AssistantLink";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantAutomationActivationReview, AssistantPart } from "@repo/contracts";
import {
  AssistantAutomationActivation,
  automationActivationRequest,
  automationActivationContinuation,
} from "./AssistantAutomationActivation";

const api = vi.hoisted(() => ({ reviewActivation: vi.fn(), activate: vi.fn() }));
vi.mock("@/lib/api/assistant-automations", () => ({ assistantAutomationsApi: api }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "test-host" }));

const request: AssistantAutomationActivationReview = {
  kind: "automation_activation_review",
  organizationId: "org-a",
  paused: false,
  reviewPath: "/assistant/automations",
  automations: [
    {
      id: "flow-a",
      revision: 2,
      name: "Failed deployment investigator",
      projectId: "app-a",
      projectName: "Website",
      trigger: "deployment.failed",
      provider: "codex",
      model: "",
      mode: "report",
      action: "none",
      allowedActions: [],
      instructions: "",
      channelIds: [],
      cooldownMinutes: 30,
      dailyLimit: 5,
      enabled: false,
      createdAt: "2026-10-30T00:00:00Z",
    },
  ],
};
const part = (
  output: unknown,
  name = "post_assistant_automation_activation_review",
  isError = false,
): AssistantPart => ({
  type: "tool",
  tool: { id: "call", name, input: {}, output: JSON.stringify(output), isError },
});
describe("automation activation handoff", () => {
  it("accepts only successful, schema-validated results from the activation review tool", () => {
    for (const prefix of ["", "mcp__openship__", "openship.", "functions."])
      expect(
        automationActivationRequest(
          part(
            { content: [{ type: "text", text: JSON.stringify({ data: request }) }] },
            `${prefix}post_assistant_automation_activation_review`,
          ),
        ),
      ).toEqual(request);
    expect(automationActivationRequest(part(request, "get_projects"))).toBeNull();
    expect(automationActivationRequest(part(request, undefined, true))).toBeNull();
    expect(
      automationActivationRequest(
        part({ isError: true, content: [{ type: "text", text: JSON.stringify(request) }] }),
      ),
    ).toBeNull();
    expect(automationActivationRequest({ type: "text", text: JSON.stringify(request) })).toBeNull();
    expect(
      automationActivationRequest(part({ ...request, reviewPath: "https://elsewhere.test" })),
    ).toBeNull();
    expect(
      automationActivationRequest(
        part({ ...request, automations: [{ ...request.automations[0], revision: -1 }] }),
      ),
    ).toBeNull();
    expect(automationActivationRequest(part({ ...request, automations: [] }))).toBeNull();
  });
  it("starts compact and never enables anything or continues from rendering alone", () => {
    const html = renderToStaticMarkup(
      <AssistantAutomationActivation
        request={request}
        onContinue={async () => {
          throw new Error("User approval required");
        }}
      />,
    );
    expect(html).toContain("Review &amp; enable");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Enable &amp; continue");
    expect(html).not.toContain("react-flow");
  });
  it("continues with the observed IDs and revisions without echoing instructions or granting more access", () => {
    const text = automationActivationContinuation({
      ...request,
      paused: true,
      automations: request.automations.map((flow) => ({
        ...flow,
        enabled: true,
        revision: 3,
        instructions: "DO_NOT_ECHO_INSTRUCTIONS",
      })),
    });
    expect(text).toContain('"id":"flow-a"');
    expect(text).toContain('"revision":3');
    expect(text).toContain("still globally paused");
    expect(text).toContain("only to the reviewed flows");
    expect(text).not.toContain("DO_NOT_ECHO_INSTRUCTIONS");
  });
});

it("reloads saved details and clears automatic approval after editing in a drawer", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const automatic = {
    ...request,
    automations: request.automations.map((flow) => ({ ...flow, mode: "automatic" as const })),
  };
  api.reviewActivation.mockResolvedValue(automatic);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (revision: number) => (
    <AssistantNavigationContext.Provider
      value={{
        href: (href) => href,
        navigate: () => {},
        close: () => {},
        changed: () => {},
        open: false,
        revision,
      }}
    >
      <AssistantAutomationActivation request={automatic} />
    </AssistantNavigationContext.Provider>
  );
  const approve = () =>
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Enable automations"),
    )!;
  try {
    await act(async () => root.render(render(0)));
    await act(async () => host.querySelector("button")!.click());
    const consent = host.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    await act(async () => consent.click());
    expect(consent.getAttribute("aria-checked")).toBe("true");
    expect(approve().disabled).toBe(false);
    api.reviewActivation.mockResolvedValue({
      ...automatic,
      automations: automatic.automations.map((flow) => ({
        ...flow,
        name: "Updated flow",
        revision: 3,
      })),
    });
    await act(async () => root.render(render(1)));
    expect(host.textContent).toContain("Updated flow");
    expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(approve().disabled).toBe(true);
    expect(api.activate).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
