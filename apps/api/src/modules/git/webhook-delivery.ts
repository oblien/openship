import { repos } from "@repo/db";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  WEBHOOK_HANDLER_FAILURE,
  type WebhookHandlerResult,
  type WebhookProviderName,
} from "@repo/platform/engine/modules/webhooks/webhook.types";

export async function processGitDelivery(
  provider: WebhookProviderName,
  event: string,
  deliveryId: string | undefined,
  dispatch: (handled: Set<string>) => Promise<WebhookHandlerResult>,
): Promise<WebhookHandlerResult> {
  let anchorId = "";
  const handledProjectIds = new Set<string>();
  if (deliveryId) {
    const claim = await repos.webhookDelivery
      .claimProviderDelivery(provider, { deliveryId, event, outcome: "received" })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "api/modules/git/webhook-delivery");
        return { claimed: true, id: "" };
      });
    if (!claim.claimed) {
      return { success: true, event, message: "Duplicate delivery ignored" };
    }
    anchorId = claim.id;
    if ("handledProjectIds" in claim) {
      for (const id of claim.handledProjectIds ?? []) handledProjectIds.add(id);
    }
  }

  let result: WebhookHandlerResult;
  try {
    result = await dispatch(handledProjectIds);
  } catch (error) {
    if (anchorId) {
      await repos.webhookDelivery
        .markProcessed(anchorId, {
          outcome: "failed",
          statusCode: 500,
          error: WEBHOOK_HANDLER_FAILURE,
          summary: { handledProjectIds: [...handledProjectIds] },
        })
        .catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "api/modules/git/webhook-delivery");
        });
    }
    throw error;
  }

  if (anchorId) {
    await repos.webhookDelivery
      .markProcessed(anchorId, {
        outcome: result.success ? "received" : "failed",
        statusCode: result.success ? 200 : 500,
        error: result.error,
        summary: { handledProjectIds: [...handledProjectIds] },
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "api/modules/git/webhook-delivery");
      });
  }
  return result;
}
