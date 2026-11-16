"use client";

import type { ToolActivityConfig, ToolCall } from "@mindwire-ai/client";
import type { AssistantMessage } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { AssistantToolResult } from "./AssistantToolResult";
import { AssistantToolResources } from "./AssistantToolResources";
import { combineToolPreviews } from "./tool-previews";
import {
  assistantToolName,
  assistantToolState,
  describeAssistantTool,
  presentToolResult,
  type AssistantTool,
} from "./tool-presentation";

function nativeTool(call: ToolCall): AssistantTool {
  const metadata = call.message.metadata;
  return {
    id: call.id,
    name: call.name,
    input: metadata?.args,
    output: metadata?.content as string | undefined,
    isError: call.status === "failed",
    action: metadata?.nativeAction as AssistantTool["action"],
  };
}

/** Orchestration wrappers do not repeat the actual MCP action in the transcript. */
export function visibleAssistantParts(message: AssistantMessage) {
  const hasMcp = message.parts?.some((part) => part.tool?.action?.kind === "mcp");
  return message.parts
    ?.filter((part) => {
      if (!part.tool) return true;
      const name = assistantToolName(part.tool);
      return (
        !hasMcp ||
        (name !== "wait" &&
          (name !== "exec" ||
            (typeof part.tool.input === "string" && part.tool.input.includes("ALL_TOOLS"))))
      );
    })
    .map((part) =>
      part.tool && assistantToolState(part.tool, false) === "failed"
        ? { ...part, tool: { ...part.tool, isError: true } }
        : part,
    );
}

export const assistantTools: ToolActivityConfig = {
  mode: "inline",
  describeTool(call) {
    const description = describeAssistantTool(nativeTool(call));
    return {
      label: description.title,
      groupKey: description.title,
      icon: <Icon name={description.icon} className="size-4" />,
    };
  },
  renderDetails({ call, loading, error, close }) {
    if (loading || error) return undefined;
    return (
      <AssistantToolResult
        tool={nativeTool(call)}
        active={call.status === "running"}
        onNavigate={close}
      />
    );
  },
  renderInline({ calls, open }) {
    // Retain OpenShip's write receipts and setup offers. Routine reads remain in details.
    const latest = new Map<string, string>();
    for (const call of calls) latest.set(assistantToolName(nativeTool(call)), call.id);
    const previews = combineToolPreviews(
      calls.flatMap((call) => {
        const tool = nativeTool(call);
        const name = assistantToolName(tool);
        if (!/^(post|put|patch|delete)_/.test(name) && latest.get(name) !== call.id) return [];
        const view = presentToolResult(tool);
        return view?.items.length &&
          (!name.startsWith("get_") || view.items.some((item) => item.setup))
          ? [{ index: call.id, view }]
          : [];
      }),
    );
    if (!previews.length) return null;
    return (
      <div className="mt-3 grid gap-3">
        {previews.map(({ index, view, itemCalls }) => (
          <AssistantToolResources
            key={view.kind ?? index}
            view={view}
            compact
            onDetails={(id) => open((id && itemCalls?.get(id)) || index)}
          />
        ))}
      </div>
    );
  },
};
