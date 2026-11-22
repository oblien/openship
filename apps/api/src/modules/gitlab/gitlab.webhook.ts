import { createHmac, timingSafeEqual } from "node:crypto";
import { GITLAB_PROVIDER, parseGitRepositoryReference } from "@repo/core";
import { repositorySigningKeys } from "@repo/platform/engine/modules/git/webhook-keys";
import {
  classifyChangedFiles,
  FORCE_DEPLOY_MESSAGE,
} from "@repo/platform/engine/modules/git/changed-files";
import type { WebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.types";
import { processGitDelivery } from "../git/webhook-delivery";
import { triggerBranchDeployments } from "../git/webhook-push";

interface Push {
  object_kind?: string;
  project?: { path_with_namespace?: string; default_branch?: string };
  ref?: string;
  before?: string;
  after?: string;
  commits?: Array<{ id: string; message: string }>;
}

function repository(payload: Push | null) {
  const path = payload?.project?.path_with_namespace;
  if (typeof path !== "string" || path.includes(":")) return null;
  const parsed = parseGitRepositoryReference(path, GITLAB_PROVIDER.id);
  if (!parsed || parsed.owner + "/" + parsed.repo !== path) return null;
  return { provider: parsed.provider, namespace: parsed.owner, name: parsed.repo };
}

export const gitlabWebhookProvider: WebhookProvider = {
  name: GITLAB_PROVIDER.id,
  async verify(raw, headers) {
    const id = headers["webhook-id"],
      stamp = headers["webhook-timestamp"],
      signature = headers["webhook-signature"];
    if (
      !id ||
      id.length > 200 ||
      !/^\d{1,12}$/.test(stamp ?? "") ||
      !signature ||
      Math.abs(Date.now() / 1000 - Number(stamp)) > 300
    )
      return { valid: false };
    let push: Push;
    try {
      push = JSON.parse(raw.toString());
    } catch {
      /* diagnostics-ignore: reject malformed delivery. */ return { valid: false };
    }
    const ref = repository(push);
    if (!ref) return { valid: false };
    const keys = await repositorySigningKeys(ref);
    const signatures = signature.split(" ").map((value) => Buffer.from(value));
    const matches = keys.filter(({ secret }) => {
      if (!secret) return false;
      const mac = createHmac("sha256", Buffer.from(secret, "base64"))
        .update(id + "." + stamp + ".")
        .update(raw)
        .digest("base64");
      const expected = Buffer.from("v1," + mac);
      return signatures.some(
        (actual) => expected.length === actual.length && timingSafeEqual(expected, actual),
      );
    });
    const organizationIds = [...new Set(matches.map((match) => match.organizationId))];
    return { valid: organizationIds.length > 0, organizationIds };
  },
  async handle(payload, headers, verified) {
    const push = payload as Push;
    const ref = repository(push);
    if (!verified?.valid || !verified.organizationIds?.length || !ref)
      return { success: false, error: "Unverified GitLab delivery" };
    if (
      push.object_kind !== "push" ||
      !push.ref?.startsWith("refs/heads/") ||
      /^0+$/.test(push.after ?? "")
    )
      return { success: true, message: "Ignored non-branch push" };
    const after = push.after;
    if (!after || !/^[a-f\d]{40,64}$/i.test(after))
      return { success: false, error: "Invalid push revision" };
    const message = push.commits?.find((c) => c.id === after)?.message;
    return processGitDelivery(
      "gitlab",
      "push",
      verified.organizationIds[0] + "/" + headers["webhook-id"],
      (handled) =>
        triggerBranchDeployments(
          {
            event: "push",
            repository: ref,
            branch: push.ref!.slice("refs/heads/".length),
            commitSha: after,
            commitMessage: message,
            defaultBranch: push.project?.default_branch,
            organizationIds: verified.organizationIds,
            actionEvent: {},
            async changes(repo, options) {
              // Compare trees across the push, including force-pushes. GitLab only
              // embeds the last 20 commits and omits commits for new branches.
              const comparison =
                push.before && !/^0+$/.test(push.before)
                  ? await repo.compare(push.before, after)
                  : null;
              const files = new Set(comparison?.files);
              if (!comparison || comparison.truncated || FORCE_DEPLOY_MESSAGE.test(message ?? ""))
                return { files, forceAll: true, truncated: comparison?.truncated };
              return { files, ...classifyChangedFiles(files, options) };
            },
          },
          handled,
        ),
    );
  },
};
