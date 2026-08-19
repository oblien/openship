/**
 * Azure DevOps Service Hook provider — Basic Auth verify + push dispatch.
 */

import type { WebhookProvider } from "../webhooks/webhook.types";
import { decrypt } from "../../lib/encryption";
import { parseGitRepoUrl } from "@repo/core";
import { repos } from "@repo/db";
import { handleAzurePush } from "./azure-webhook-push";
import { verifyAzureBasicAuth } from "./azure.webhook-verify";

export { verifyAzureBasicAuth };

async function collectAzureSecrets(payload: string | Buffer): Promise<string[]> {
  let parsed: unknown;
  try {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const remoteUrl = (parsed as {
    resource?: { repository?: { remoteUrl?: string } };
  })?.resource?.repository?.remoteUrl;
  const parsedUrl = parseGitRepoUrl(remoteUrl ?? "");
  if (!parsedUrl || parsedUrl.provider !== "azure" || !parsedUrl.project) return [];

  const projects = await repos.project
    .findByAzureGitRepo(parsedUrl.owner, parsedUrl.project, parsedUrl.repo)
    .catch(() => []);
  const secrets: string[] = [];
  for (const p of projects) {
    if (!p.webhookSecret) continue;
    try {
      secrets.push(decrypt(p.webhookSecret));
    } catch {
      /* skip rotated/corrupt */
    }
  }
  return secrets;
}

export const azureWebhookProvider: WebhookProvider = {
  name: "azure",

  async verify(payload, headers) {
    const secrets = await collectAzureSecrets(payload);
    return verifyAzureBasicAuth(headers, secrets);
  },

  async handle(payload) {
    return handleAzurePush(payload);
  },
};
