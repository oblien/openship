import type { SystemIssue } from "@repo/contracts";
import type { Dictionary } from "@/i18n";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type AssistantInvestigation =
  | { kind: "deployment"; deploymentId: string; projectId?: string }
  | { kind: "issue"; projectId: string; issueId: string; intent?: "fix" }
  | { kind: "monitoring" };

type Search = Pick<URLSearchParams, "get" | "getAll" | "has">;
const identifier = (value: string | null | undefined): value is string =>
  !!value && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value);
// Resource scope can include a Cloud account email. Bind the handoff without
// exposing that identity in URLs. This is a UI guard, never an authorization token.
const scopeKey = (scope: string) => bytesToHex(sha256(new TextEncoder().encode(scope)));

/** Links carry identifiers only. Logs, errors, names and instructions stay out of URLs. */
export function investigationHref(target: AssistantInvestigation, scope: string): string | null {
  const params = new URLSearchParams({ investigate: target.kind, scope: scopeKey(scope) });
  if ("projectId" in target && target.projectId) params.set("project", target.projectId);
  if (target.kind === "deployment") params.set("deployment", target.deploymentId);
  else if (target.kind === "issue") {
    params.set("issue", target.issueId);
    if (target.intent) params.set("intent", target.intent);
  }
  return readInvestigation(params, scope).status === "ready"
    ? `/assistant?${params.toString()}`
    : null;
}

export function readInvestigation(
  search: Search,
  scope: string,
):
  | { status: "none" | "invalid" }
  | { status: "ready"; target: AssistantInvestigation; key: string } {
  if (!search.has("investigate")) return { status: "none" };
  if (
    !scope ||
    search.get("scope") !== scopeKey(scope) ||
    search.has("chat") ||
    ["investigate", "scope", "project", "deployment", "issue", "intent"].some(
      (key) => search.getAll(key).length > 1,
    )
  )
    return { status: "invalid" };
  const kind = search.get("investigate");
  const projectId = search.get("project");
  if (search.has("project") && !identifier(projectId)) return { status: "invalid" };
  const deploymentId = search.get("deployment"),
    issueId = search.get("issue");
  const intent = search.get("intent");
  if (search.has("intent") && (kind !== "issue" || intent !== "fix")) return { status: "invalid" };
  let target: AssistantInvestigation;
  if (kind === "deployment" && identifier(deploymentId) && !search.has("issue")) {
    target = { kind, deploymentId, ...(projectId ? { projectId } : {}) };
  } else if (
    kind === "issue" &&
    identifier(issueId) &&
    identifier(projectId) &&
    !search.has("deployment")
  ) {
    target = { kind, issueId, projectId, ...(intent === "fix" ? { intent } : {}) };
  } else if (
    kind === "monitoring" &&
    !search.has("project") &&
    !search.has("deployment") &&
    !search.has("issue")
  ) {
    target = { kind };
  } else return { status: "invalid" };
  return { status: "ready", target, key: JSON.stringify(target) };
}

export function issueInvestigation(
  issue: SystemIssue,
  intent?: "fix",
): AssistantInvestigation | null {
  if (issue.resolvedAt || issue.source === "update" || issue.target.scope !== "project")
    return null;
  if (!identifier(issue.target.id) || !identifier(issue.id)) return null;
  return {
    kind: "issue",
    projectId: issue.target.id,
    issueId: issue.id,
    ...(intent ? { intent } : {}),
  };
}

export function investigationPrompt(
  target: AssistantInvestigation,
  copy: Dictionary["dashboard"]["investigation"],
): string {
  if (target.kind === "monitoring") return copy.reportPrompt;
  const fixing = target.kind === "issue" && target.intent === "fix";
  const task =
    target.kind === "deployment"
      ? copy.deploymentPrompt.replace("{deploymentId}", target.deploymentId)
      : (fixing ? copy.fixPrompt : copy.issuePrompt).replace("{issueId}", target.issueId);
  return [
    task,
    target.projectId ? copy.appContext.replace("{projectId}", target.projectId) : "",
    fixing ? copy.fixInstructions : copy.instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}
