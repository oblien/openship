import { afterEach, expect, it, vi } from "vitest";
import { seedOrg, seedProject } from "../../helpers/seed";
import { repos } from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import * as github from "@repo/platform/engine/modules/github/github.service";
import { repositoryWebhooks } from "@repo/platform/engine/modules/git/provider";
import { syncSharedWebhookId } from "@repo/platform/engine/modules/projects/project-git-webhook";

afterEach(() => vi.restoreAllMocks());

it("does not share a repository webhook with another organization or provider", async () => {
  const { organizationId } = await seedOrg();
  const foreign = await seedOrg();
  const fields = { gitOwner: "acme", gitRepo: "app", autoDeploy: true };
  const matched = await seedProject(organizationId, fields);
  const mixedCase = await seedProject(organizationId, { gitOwner: "Acme", gitRepo: "APP" });
  const legacy = await seedProject(organizationId, { ...fields, gitProvider: null });
  const otherProvider = await seedProject(organizationId, { ...fields, gitProvider: "gitlab" });
  const otherOrg = await seedProject(foreign.organizationId, fields);
  const ref = { provider: "github", namespace: "acme", name: "app" };
  await syncSharedWebhookId(organizationId, ref, "42");
  for (const p of [matched, mixedCase, legacy]) expect((await repos.project.findById(p.id))?.webhookId).toBe("42");
  for (const p of [otherOrg, otherProvider]) expect((await repos.project.findById(p.id))?.webhookId).toBeNull();
  await repos.project.update(otherProvider.id, { webhookId: "80" });
  const repairs = (await repos.project.listNeedingWebhookBackfill("github")).map(project => project.id);
  expect(repairs).toEqual(expect.arrayContaining([matched.id, legacy.id]));
  expect(repairs).not.toContain(otherProvider.id);
  expect((await repos.project.findByGitRepo({ ...ref, provider: "gitlab" }, [organizationId])).map(p => p.id))
    .toEqual([otherProvider.id]);
});

it("rejects malformed opaque webhook IDs before they can reach GitHub's mutation API", async () => {
  const remove = vi.spyOn(github, "deleteWebhook");
  const update = vi.spyOn(github, "updateWebhook");
  const hooks = repositoryWebhooks({} as ExecutionContext, {
    provider: "github",
    namespace: "acme",
    name: "app",
  });
  for (const id of ["../42", "NaN", "1.5", "-1", "9007199254740993"]) {
    await expect(hooks.delete(id)).rejects.toMatchObject({ code: "GIT_WEBHOOK_ID_INVALID" });
    await expect(hooks.setActive(id, false)).rejects.toMatchObject({
      code: "GIT_WEBHOOK_ID_INVALID",
    });
  }
  expect(remove).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
