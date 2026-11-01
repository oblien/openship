import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantToolActivity } from "./AssistantToolActivity";
import { automationFlowSteps } from "./automation-flow";
import { presentToolResult, type AssistantTool } from "./tool-presentation";
import { combineToolPreviews } from "./tool-previews";

const flow = {
  id: "flow-a",
  name: "Website investigation",
  projectName: "Website",
  trigger: "service.unhealthy",
  provider: "codex",
  mode: "report",
  action: "none",
  channelIds: [],
  enabled: false,
};
const call = (data: unknown, name = "post_assistant_automations"): AssistantTool => ({
  id: "call",
  name,
  input: {},
  output: JSON.stringify({ data }),
});
const preview = (data: unknown, index: number, name?: string) => ({
  index: String(index),
  view: presentToolResult(call(data, name))!,
});

describe("automation tool previews", () => {
  it("combines distinct creations in one collection, with actual names and flow configuration", () => {
    const result = combineToolPreviews([
      preview(flow, 0),
      preview({ ...flow, id: "flow-b", name: "Failed builds", trigger: "deployment.failed" }, 1),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].view.total).toBe(2);
    expect(result[0].view.items.map((item) => item.title)).toEqual([
      "Website investigation",
      "Failed builds",
    ]);
    expect(result[0].view.items[0].automation?.trigger).toBe("service.unhealthy");
    expect(result[0].itemCalls?.get("flow-a")).toBe("0");
    expect(result[0].itemCalls?.get("flow-b")).toBe("1");
  });
  it("deduplicates the same ID across create, update and reads using chronological results", () => {
    const result = combineToolPreviews([
      preview(
        { ...flow, name: "Updated flow", enabled: true },
        3,
        "put_assistant_automations_by_id",
      ),
      preview(flow, 0),
      preview({ automations: [flow] }, 1, "get_assistant_automations"),
    ]);
    expect(result[0].view.items).toHaveLength(1);
    expect(result[0].view.items[0]).toMatchObject({ title: "Updated flow", status: "Enabled" });
    expect(result[0].itemCalls?.get("flow-a")).toBe("3");
  });
  it("keeps all write calls inspectable even when they concern the same automation", () => {
    const html = renderToStaticMarkup(
      <AssistantToolActivity
        active={false}
        parts={[
          { type: "tool", tool: call(flow) },
          { type: "tool", tool: call(flow) },
        ]}
      />,
    );
    expect(html).toContain("Create automation · Completed · 2 calls");
    expect(html.match(/aria-label="Automations from tool"/g)).toHaveLength(1);
    expect(html).toContain("Website investigation");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('href="/assistant/automations/flow-a/edit"');
    expect(html).not.toContain("react-flow");
  });
  it("does not invent saved configuration from input or show success for failed writes", () => {
    const request = { ...call({ id: "flow-a" }), input: flow };
    expect(presentToolResult(request)?.items[0].automation).toBeUndefined();
    expect(presentToolResult({ ...request, isError: true })).toBeNull();
    expect(
      presentToolResult(call({ ...flow, mode: "unexpected" }))?.items[0].automation,
    ).toBeUndefined();
    expect(
      presentToolResult(call({ ...flow, trigger: { toString: "invalid" } }))?.items[0].automation,
    ).toBeUndefined();
    expect(presentToolResult(call({ ...flow, id: "../settings" }))).toBeNull();
  });
  it("uses the saved trigger, response policy and channel count in the nodes", () => {
    const view = presentToolResult(
      call({ ...flow, mode: "approve", action: "restart", channelIds: ["channel-1", "channel-2"] }),
    )!;
    const steps = automationFlowSteps(view.items[0].automation!);
    expect(steps.map((step) => step.summary)).toEqual([
      "Service unhealthy",
      "Codex",
      "Review before fixing",
      "Chat + 2 channels",
    ]);
    expect(steps[2].detail).toBe("1 allowed action");
  });
});
