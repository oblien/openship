import { expect, it } from "vitest";
import { repos } from "@repo/db";
import { seedOrg, seedProject, seedDeployment } from "../../helpers/seed";

it("merges worker build receipts without overwriting saved configuration or concurrent cancellation", async () => {
  const org = await seedOrg();
  const project = await seedProject(org.organizationId);
  const dep = await seedDeployment(project, {
    status: "building",
    meta: { source: "frozen", managedWorkspaceId: "host" },
  });
  const receipt = {
    version: 1,
    images: [{ imageRef: "openship/app:bld_done", imageId: `sha256:${"a".repeat(64)}` }],
  };
  expect(await repos.deployment.recordCompletedBuildArtifacts(dep.id, "another-org", receipt)).toBe(
    false,
  );
  expect(
    await repos.deployment.recordCompletedBuildArtifacts(dep.id, org.organizationId, receipt),
  ).toBe(true);
  const saved = await repos.deployment.findById(dep.id);
  expect(saved?.status).toBe("building");
  expect(saved?.artifactRetainedAt).toBeInstanceOf(Date);
  expect(saved?.meta).toMatchObject({
    source: "frozen",
    managedWorkspaceId: "host",
    completedBuildArtifacts: receipt,
  });
  await repos.deployment.updateStatus(dep.id, "cancelled");
  expect(
    await repos.deployment.recordCompletedBuildArtifacts(dep.id, org.organizationId, {
      version: 2,
    }),
  ).toBe(false);
  expect((await repos.deployment.findById(dep.id))?.status).toBe("cancelled");
  expect((await repos.deployment.findById(dep.id))?.meta).toMatchObject({
    completedBuildArtifacts: receipt,
  });
});
