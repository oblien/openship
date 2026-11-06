import { describe, expect, it } from "vitest";
import {
  assistantDrawerHref,
  assistantDrawerViews,
  closeAssistantDrawerHref,
} from "./assistant-navigation";

const search = (href: string) => new URL(href, "https://openship.test").search.slice(1);

describe("assistant drawer navigation", () => {
  it.each([
    "chat=chat-1",
    "new=1&investigate=deployment&resource=build-1",
    "automation=flow-1",
    "tab=automations&run=run-1",
  ])("returns to the original workspace context: %s", (context) => {
    const href = assistantDrawerHref("/assistant/automations/new", "/assistant", context);
    expect(assistantDrawerViews(search(href))).toEqual([
      { kind: "automation", id: undefined, trigger: "deployment.failed", agentId: undefined },
    ]);
    expect(closeAssistantDrawerHref("/assistant", search(href))).toBe(`/assistant?${context}`);
  });

  it("preserves the automation beneath agent creation and closes one view at a time", () => {
    const flow = assistantDrawerHref(
      "/assistant/automations/new?trigger=service.unhealthy&agent=scout",
      "/assistant",
      "chat=chat-1",
    );
    const agent = assistantDrawerHref(
      "/assistant/agents/new?template=logs&project=app-1",
      "/assistant",
      search(flow),
    );
    expect(assistantDrawerViews(search(agent))).toEqual([
      { kind: "automation", id: undefined, trigger: "service.unhealthy", agentId: "scout" },
      { kind: "agent", id: undefined, editing: true, template: "logs", project: "app-1" },
    ]);
    expect(closeAssistantDrawerHref("/assistant", search(agent))).toBe(flow);
    expect(closeAssistantDrawerHref("/assistant", search(flow))).toBe("/assistant?chat=chat-1");
  });

  it("starts a flow for the selected agent without retaining stale editor options", () => {
    const href = assistantDrawerHref(
      "/assistant/automations/new?agent=scout",
      "/assistant",
      "new=1&agents=scout&agent-template=logs&agent-project=app-1&automation-editor=old%2Fedit&automation-trigger=service.unhealthy&automation-agent=old",
    );
    const params = new URLSearchParams(search(href));
    expect(params.has("agents")).toBe(false);
    expect(params.has("agent-template")).toBe(false);
    expect(params.has("agent-project")).toBe(false);
    expect(assistantDrawerViews(search(href))).toEqual([
      { kind: "automation", id: undefined, trigger: "deployment.failed", agentId: "scout" },
    ]);
    expect(closeAssistantDrawerHref("/assistant", search(href))).toBe("/assistant?new=1");
  });

  it("opens existing automation links in place and copies only editor options", () => {
    const href = assistantDrawerHref(
      "/assistant/automations/flow-1/edit?enabled=true&run=now",
      "/assistant",
      "chat=chat-1",
    );
    expect(assistantDrawerViews(search(href))).toEqual([
      { kind: "automation", id: "flow-1", trigger: "deployment.failed", agentId: undefined },
    ]);
    expect(search(href)).not.toMatch(/enabled|run=/);
  });

  it("keeps existing agent deep links compatible", () => {
    const href = assistantDrawerHref(
      "/assistant/agents/scout/edit",
      "/assistant",
      "new=1&agent-template=logs&agent-project=app-1",
    );
    expect(href).toBe("/assistant?new=1&agents=scout%2Fedit");
    expect(assistantDrawerViews("agents=all")[0]).toMatchObject({
      kind: "agent",
      editing: false,
      id: undefined,
    });
    expect(assistantDrawerViews(search(href))[0]).toMatchObject({
      kind: "agent",
      editing: true,
      id: "scout",
    });
  });

  it("leaves ordinary and external navigation unchanged", () => {
    for (const href of [
      "/assistant?chat=other",
      "/assistant?tab=automations",
      "/settings",
      "https://example.com/assistant/automations/new",
    ]) {
      expect(assistantDrawerHref(href, "/assistant", "chat=chat-1")).toBe(href);
    }
    expect(assistantDrawerViews("automation=flow-1")).toEqual([]);
    expect(assistantDrawerViews("automation-editor=flow-1/delete")).toEqual([]);
    expect(closeAssistantDrawerHref("/assistant", "automation-editor=new")).toBe("/assistant");
  });
});
