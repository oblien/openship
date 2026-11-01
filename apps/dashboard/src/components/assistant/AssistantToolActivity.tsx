"use client";

import { useState } from "react";
import type { AssistantPart } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { AssistantDialog } from "./AssistantDialog";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantLiveIndicator } from "./AssistantLiveIndicator";
import { AssistantToolResult } from "./AssistantToolResult";
import { AssistantToolResources } from "./AssistantToolResources";
import { combineToolPreviews } from "./tool-previews";
import {
  assistantToolName,
  assistantToolState,
  describeAssistantTool,
  presentToolResult,
  type ToolState,
} from "./tool-presentation";

const stateLabel: Record<ToolState, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function AssistantToolActivity({
  parts,
  active,
  streaming = false,
}: {
  parts: AssistantPart[];
  active: boolean;
  streaming?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const tools = parts.flatMap((part, index) =>
    part.tool ? [{ tool: part.tool, index: String(index) }] : [],
  );
  const hasMcpCalls = tools.some(({ tool }) => tool.action?.kind === "mcp");
  const groups = new Map<string, typeof tools>();
  for (const call of tools) {
    const name = assistantToolName(call.tool);
    // Native MCP calls are the actual actions. Keep their orchestration wrappers
    // in the inspector without presenting a second action for the same work.
    const discovery =
      name === "exec" &&
      typeof call.tool.input === "string" &&
      call.tool.input.includes("ALL_TOOLS");
    if (hasMcpCalls && (name === "wait" || (name === "exec" && !discovery))) continue;
    const group = discovery ? "discovery" : name;
    groups.set(group, [...(groups.get(group) ?? []), call]);
  }
  const thinking = parts
    .filter((part) => part.type === "thinking")
    .map((part) => part.text)
    .join("\n");
  const thinkingNow = streaming && parts.at(-1)?.type === "thinking";
  const opened = tools.find((call) => call.index === selected)?.tool;
  const description = opened
    ? describeAssistantTool(opened)
    : { title: "Reasoning", icon: "assistant" as const };
  const state = opened ? assistantToolState(opened, active) : null;
  const previews = combineToolPreviews(
    [...groups].flatMap(([name, calls]) =>
      (/^(post|put|patch|delete)_/.test(name) ? calls : [calls.at(-1)!]).flatMap((call) => {
        const view = presentToolResult(call.tool);
        return view ? [{ index: call.index, view }] : [];
      }),
    ),
  );
  return (
    <div className="grid min-w-0 gap-3">
      {thinking && (
        <div>
          <button
            type="button"
            aria-label={thinkingNow ? "Thinking" : "Thought process"}
            aria-expanded={showThinking}
            onClick={() => setShowThinking(!showThinking)}
            className="flex items-center gap-2 rounded-lg py-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="assistant" className="size-4" />
            {thinkingNow ? <AssistantLiveIndicator label="Thinking" /> : "Thought process"}
            <Icon
              name="chevron-right"
              className={`size-3 transition-transform ${showThinking ? "rotate-90" : ""}`}
            />
          </button>
          {showThinking && (
            <div className="mt-2 border-s-2 border-foreground/10 ps-4 pb-2">
              <AssistantMarkdown streaming={thinkingNow}>{thinking}</AssistantMarkdown>
            </div>
          )}
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        aria-label="Tool activity"
      >
        {[...groups].map(([name, calls]) => {
          const last = calls.at(-1)!;
          const failed = calls.find((call) => assistantToolState(call.tool, active) === "failed");
          const running = calls.find((call) => assistantToolState(call.tool, active) === "running");
          const callState = running
            ? "running"
            : failed
              ? "failed"
              : assistantToolState(last.tool, active);
          const meta = describeAssistantTool(last.tool);
          return (
            <button
              type="button"
              key={name}
              aria-label={`${meta.title} · ${stateLabel[callState]}${calls.length > 1 ? ` · ${calls.length} calls` : ""}`}
              onClick={() => setSelected((running ?? failed ?? last).index)}
              className="group/tool flex min-w-0 items-center gap-2 rounded-lg bg-card/70 px-3 py-2.5 text-start transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name={meta.icon} className="size-4 shrink-0" />
              <span className="truncate font-medium text-foreground">{meta.title}</span>
              {calls.length > 1 && (
                <span className="text-[11px] tabular-nums">×{calls.length}</span>
              )}
              <span
                className={`text-[11px] ${callState === "failed" ? "text-danger" : "text-muted-foreground"}`}
              >
                {running ? <AssistantLiveIndicator label="Running" /> : stateLabel[callState]}
              </span>
              <Icon
                name={
                  callState === "failed"
                    ? "alert-circle"
                    : callState === "completed"
                      ? "check"
                      : callState === "stopped"
                        ? "pause"
                        : "chevron-right"
                }
                className={`size-3 shrink-0 ${callState === "failed" ? "text-danger" : "opacity-70"}`}
              />
            </button>
          );
        })}
      </div>
      {previews.map(({ index, view, itemCalls }) => (
        <AssistantToolResources
          key={view.kind ?? index}
          view={view}
          compact
          onDetails={(id) => setSelected((id && itemCalls?.get(id)) || index)}
        />
      ))}
      <AssistantDialog
        label="Tool details"
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        width="800px"
        maxWidth="calc(100vw - 24px)"
        maxHeight="calc(100dvh - 32px)"
        overflow="hidden"
      >
        <div className="flex shrink-0 items-center gap-3 px-5 pt-6 pb-5 pe-14 sm:px-7 sm:pe-16">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-[var(--st-info-fg)]">
            <Icon name={description.icon} className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-medium text-foreground sm:text-lg">
              {description.title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className={state ? "hidden sm:inline" : ""}>
                {opened ? "Tool call · OpenShip" : "Agent reasoning"}
              </span>
              {state && (
                <span className={`sm:hidden ${state === "failed" ? "text-danger" : ""}`}>
                  {stateLabel[state]}
                </span>
              )}
            </p>
          </div>
          {state && (
            <span
              className={`hidden rounded-lg px-2.5 py-1.5 text-xs sm:inline-flex ${state === "failed" ? "text-danger bg-[var(--st-danger-bg)]" : state === "running" ? "text-[var(--st-info-fg)] bg-[var(--st-info-bg)]" : "text-muted-foreground bg-background"}`}
            >
              {stateLabel[state]}
            </span>
          )}
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-7">
          {opened && tools.length > 1 && (
            <div className="mb-5">
              <CustomSelect
                aria-label="Select tool call"
                value={selected!}
                onChange={setSelected}
                variant="filled"
                options={tools.map((call, index) => ({
                  value: call.index,
                  label: `${index + 1}. ${describeAssistantTool(call.tool).title}`,
                  description: stateLabel[assistantToolState(call.tool, active)],
                  icon: <Icon name={describeAssistantTool(call.tool).icon} className="size-4" />,
                }))}
              />
            </div>
          )}
          {opened ? (
            <AssistantToolResult
              tool={opened}
              active={active}
              onNavigate={() => setSelected(null)}
            />
          ) : (
            <AssistantMarkdown streaming={streaming && parts.at(-1)?.type === "thinking"}>
              {thinking}
            </AssistantMarkdown>
          )}
        </div>
      </AssistantDialog>
    </div>
  );
}
