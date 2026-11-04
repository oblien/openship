"use client";
import type { AssistantPart } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { outputLabel, outputRecord, parseToolOutput } from "./tool-output";
import { assistantToolState, presentToolResult } from "./tool-presentation";
import { AssistantToolResources } from "./AssistantToolResources";
import { AssistantCopyButton } from "./AssistantCopyButton";

/** Render the returned result as data. Tool output cannot add UI actions or load remote assets. */
export function AssistantToolResult({
  tool,
  active = false,
  onNavigate,
}: {
  tool: NonNullable<AssistantPart["tool"]>;
  active?: boolean;
  onNavigate?(): void;
}) {
  const parsed = parseToolOutput(tool.output);
  const state = assistantToolState(tool, active);
  const failed = state === "failed";
  const view = presentToolResult(tool);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <p
        className={`flex items-center gap-2 text-sm ${failed ? "text-danger" : "text-muted-foreground"}`}
      >
        <Icon
          name={failed ? "alert-circle" : tool.output === undefined ? "clock" : "check"}
          className="size-4"
        />
        {failed
          ? "The operation could not be completed"
          : tool.output === undefined
            ? state === "running"
              ? "Waiting for OpenShip…"
              : "No result was received before this turn ended."
            : "Result from OpenShip"}
      </p>
      {tool.output !== undefined && (
        <div className="min-w-0">
          {view ? (
            <AssistantToolResources view={view} onNavigate={onNavigate} />
          ) : (
            <ResultValue value={parsed.value} />
          )}
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <ToolDataDetails label="Request" value={tool.input} />
        {tool.output !== undefined && <ToolDataDetails label="Result data" value={parsed.value} />}
      </div>
    </div>
  );
}
function ToolDataDetails({ label, value }: { label: string; value: unknown }) {
  const code = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <details className="min-w-0 rounded-xl bg-background px-4 py-3">
      <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
      <div className="mt-3 flex justify-end">
        <AssistantCopyButton value={code} label={`Copy ${label.toLowerCase()}`} compact />
      </div>
      <pre className="mt-2 max-h-64 overflow-auto text-xs leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {code}
      </pre>
    </details>
  );
}
function ResultValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">—</span>;
  if (typeof value !== "object")
    return (
      <span className="whitespace-pre-wrap break-words text-sm">
        {typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}
      </span>
    );
  if (depth >= 3)
    return (
      <pre className="overflow-auto text-xs whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  if (Array.isArray(value)) {
    if (!value.length)
      return <p className="py-3 text-sm text-muted-foreground">No items returned.</p>;
    return (
      <div className="grid gap-3">
        {value.slice(0, 20).map((item, index) => {
          const record = outputRecord(item);
          const title = record?.name ?? record?.title;
          return (
            <div key={index} className="min-w-0 rounded-xl bg-background p-4">
              {typeof title === "string" && (
                <p className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <Icon name="file-text" className="size-4 text-muted-foreground" />
                  {title}
                </p>
              )}
              <ResultValue
                value={
                  record && typeof title === "string"
                    ? Object.fromEntries(
                        Object.entries(record).filter(([key]) => !["name", "title"].includes(key)),
                      )
                    : item
                }
                depth={depth + 1}
              />
            </div>
          );
        })}
        {value.length > 20 && (
          <p className="text-xs text-muted-foreground">
            Showing 20 of {value.length} items. Open the raw result for the complete response.
          </p>
        )}
      </div>
    );
  }
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-3">
      {Object.entries(value).map(([key, item]) => (
        <div
          key={key}
          className={
            typeof item === "object" && item !== null
              ? "grid gap-2"
              : "grid grid-cols-[minmax(100px,1fr)_minmax(0,2fr)] gap-4"
          }
        >
          <dt className="text-sm text-muted-foreground">{outputLabel(key)}</dt>
          <dd className="min-w-0">
            <ResultValue value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
