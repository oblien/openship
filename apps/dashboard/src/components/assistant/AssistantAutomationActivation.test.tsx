import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantAutomationActivationReview, AssistantPart } from "@repo/contracts";
import {
  AssistantAutomationActivation,
  automationActivationRequest,
  automationActivationContinuation,
} from "./AssistantAutomationActivation";

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
