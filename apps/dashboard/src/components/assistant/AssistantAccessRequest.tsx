"use client";

import { Value } from "@sinclair/typebox/value";
import {
  PermissionAccessRequestSchema,
  type PermissionAccessRequest,
  type AssistantPart,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { parseToolOutput } from "./tool-output";
import { assistantToolName } from "./tool-presentation";

/** Only the ordinary tool's successful result for this connection can offer the editor. */
export function permissionRequest(
  part: AssistantPart,
  clientId: string,
): PermissionAccessRequest | null {
  const tool = part.type === "tool" ? part.tool : undefined;
  if (!tool || tool.isError || assistantToolName(tool) !== "get_permissions_access_request")
    return null;
  const result = parseToolOutput(tool.output);
  return !result.isError &&
    Value.Check(PermissionAccessRequestSchema, result.value) &&
    result.value.clientId === clientId
    ? result.value
    : null;
}

export function AccessRequestSummary({ request }: { request: PermissionAccessRequest }) {
  return (
    <div className="min-w-0 space-y-2 text-sm leading-relaxed">
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{request.reason}</p>
      <p className="whitespace-pre-wrap break-words text-foreground">{request.access}</p>
    </div>
  );
}

export function AssistantAccessRequest({
  request,
  disabled,
  accessChanged = false,
  onReview,
}: {
  request: PermissionAccessRequest;
  disabled?: boolean;
  accessChanged?: boolean;
  onReview(request: PermissionAccessRequest): void;
}) {
  return (
    <div
      className="rounded-2xl bg-card p-5"
      role="group"
      aria-label={accessChanged ? "Previous access request" : "Access requested"}
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon name="shield" className="size-4 text-muted-foreground" />
        {accessChanged ? "Access has changed" : "Access requested"}
      </div>
      <AccessRequestSummary request={request} />
      {accessChanged ? (
        <p className="mt-4 text-sm text-muted-foreground">
          This request belongs to the previous permissions. Continue below with your current access.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onReview(request)}
          >
            Review permissions
            <Icon name="arrow-right" />
          </Button>
          <span className="text-xs text-muted-foreground">Nothing changes until you save.</span>
        </div>
      )}
    </div>
  );
}
