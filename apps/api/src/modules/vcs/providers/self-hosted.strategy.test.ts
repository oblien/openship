import { describe, it, expect } from "vitest";
import { SelfHostedStrategy } from "./self-hosted.strategy";

describe("SelfHostedStrategy", () => {
  const strategy = new SelfHostedStrategy();

  const methods = [
    "getRepository", "listRepositories", "getBranches", "listFiles",
    "getFileContent", "getTree", "getCloneCredentials", "getCloneToken",
    "verifyWebhookSignature", "parseWebhookPayload", "getLatestCommit",
    "getRecentCommits", "compareCommits", "parseRepoUrl", "createCheckRun",
    "updateCheckRun", "registerWebhook", "listWebhooks", "updateWebhook",
    "deleteWebhook", "getWebhookStrategy", "resolveWebhookStrategy", "getAvailableStrategies"
  ] as const;

  for (const method of methods) {
    it(`should throw not implemented for ${method}`, async () => {
      const expected = `${method} is not yet implemented for selfhosted`;
      // Sync methods throw on call; async ones return a rejected promise. Await
      // BOTH shapes through the same assertion — an un-awaited `.rejects` would
      // let a method that resolves (the `compareCommits` -> {files: []} bug these
      // tests exist to prevent) pass silently.
      await expect(
        (async () =>
          strategy[method](null as any, null as any, null as any, null as any, null as any))(),
      ).rejects.toThrowError(expected);
    });
  }
});
