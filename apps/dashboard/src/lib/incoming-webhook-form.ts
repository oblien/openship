import type {
  IncomingWebhookActionConfig,
  IncomingWebhookActionType,
} from "@/lib/api/incoming-webhooks";

export type ServiceOptionsState = "loading" | "ready" | "error";
export type IncomingWebhookServiceSelection = string[] | null;

/** `null` is the explicit whole-project choice. Once an operator narrows the
 * scope, unchecking the final service keeps it selected; broadening back to the
 * whole project requires clicking the dedicated "all services" control. */
export function toggleIncomingWebhookServiceTarget(
  current: IncomingWebhookServiceSelection,
  serviceId: string,
): IncomingWebhookServiceSelection {
  if (current === null) return [serviceId];
  if (!current.includes(serviceId)) return [...current, serviceId];
  if (current.length === 1) return current;
  return current.filter((id) => id !== serviceId);
}

/** Keep deploy submission closed until the service scope is known. An empty
 * selection means "whole project", so treating a failed fetch as an empty list
 * would silently grant a broader webhook than the operator could inspect. */
export function canSubmitIncomingWebhook(input: {
  name: string;
  actionType: IncomingWebhookActionType;
  jobKey: string;
  busy: boolean;
  serviceOptionsState: ServiceOptionsState;
}): boolean {
  if (!input.name.trim() || input.busy) return false;
  if (input.actionType === "job") return Boolean(input.jobKey);
  return input.serviceOptionsState === "ready";
}

/** Exact persisted target identities for an auditable row summary. */
export function incomingWebhookTargetIds(config: IncomingWebhookActionConfig): string[] {
  if (config.serviceIds?.length) return config.serviceIds;
  return config.serviceId ? [config.serviceId] : [];
}
