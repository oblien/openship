import { AppError, type GitRepositoryRef } from "@repo/core";
import { repos } from "@repo/db";
import { createProvisionLock } from "../../lib/provision-lock";
import { newRepositoryHookKey, repositoryHookKey, webhookScope } from "../git/webhook-keys";
import type { GitRepositoryWebhooks } from "../git/types";
import {
  allPages,
  gitlabRequest,
  gitlabCredentials,
  isGitLabStatus,
  projectPath,
  segment,
} from "./client";

interface Hook {
  id: number;
  name: string;
  url: string;
}
export function projectHooks(
  org: string,
  ref: GitRepositoryRef,
  authorize: () => Promise<void>,
): GitRepositoryWebhooks {
  const path = "projects/" + segment(projectPath(ref)) + "/hooks";
  const scope = webhookScope(org, ref);
  const name = "OpenShip " + scope.slice(0, 24);

  async function withHooks<T>(run: (token: string, hooks: Hook[]) => Promise<T>): Promise<T> {
    await authorize();
    for (const { token } of await gitlabCredentials(org)) {
      try {
        const hooks = await allPages((page) =>
          gitlabRequest<Hook[]>(path, token, { page, per_page: "100" }),
        );
        return await run(token, hooks);
      } catch (error) {
        if (!isGitLabStatus(error, 401, 403, 404)) throw error;
      }
    }
    throw new AppError(
      "Connect a GitLab token with permission to manage this project's webhooks.",
      403,
    );
  }
  async function updateOwned(id: string, run: (token: string, hook: Hook) => Promise<unknown>) {
    if (!/^[1-9]\d*$/.test(id)) throw new AppError("Invalid GitLab webhook ID", 400);
    await withHooks(async (token, hooks) => {
      const hook = hooks.find((hook) => String(hook.id) === id && hook.name === name);
      if (hook) await run(token, hook);
    });
  }
  return {
    async register(options) {
      const url =
        options.url ?? (await import("../../lib/public-url")).sharedWebhookUrl(ref.provider);
      if (!options.projectId) throw new AppError("A linked OpenShip project is required.", 400);
      const projectId = options.projectId;
      return createProvisionLock("gitlab-hook:" + scope).run(async () => {
        const [target, siblings] = await Promise.all([
          repos.project.findById(projectId),
          repos.project.findByGitRepo(ref, [org]),
        ]);
        if (target?.organizationId !== org) throw new AppError("Project not found", 404);
        // One remote hook serves all environments. Persist its encrypted key on
        // every linked project so deleting or transferring a sibling preserves delivery.
        const projects = new Map([...siblings, target].map((project) => [project.id, project]));
        const rows = await Promise.all(
          [...projects.values()].map(async (row) => ({
            row,
            key: await repositoryHookKey(row, ref),
          })),
        );
        const current = rows.find((entry) => entry.key !== null);
        const { key, sealed } =
          current?.key && current.row.webhookSecret
            ? { key: current.key, sealed: current.row.webhookSecret }
            : await newRepositoryHookKey(scope);
        const hook = await withHooks(async (token, hooks) => {
          const existing = hooks.find((hook) => hook.name === name);
          return gitlabRequest<Hook>(
            existing ? path + "/" + existing.id : path,
            token,
            {},
            {
              method: existing ? "PUT" : "POST",
              body: JSON.stringify({
                name,
                signing_token: "whsec_" + key,
                url,
                push_events: true,
                enable_ssl_verification: true,
              }),
            },
          );
        });
        await Promise.all(
          rows
            .filter((entry) => entry.key !== key)
            .map(({ row }) => repos.project.update(row.id, { webhookSecret: sealed })),
        );
        return { id: String(hook.id), events: ["push"] };
      });
    },
    async setActive(id, active) {
      await updateOwned(id, (token, hook) =>
        gitlabRequest(
          path + "/" + id,
          token,
          {},
          {
            method: "PUT",
            body: JSON.stringify({ url: hook.url, push_events: active }),
          },
        ),
      );
    },
    async delete(id) {
      await updateOwned(id, (token) =>
        gitlabRequest(path + "/" + id, token, {}, { method: "DELETE" }),
      );
    },
  };
}
