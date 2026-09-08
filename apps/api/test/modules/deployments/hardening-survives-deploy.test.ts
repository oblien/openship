/**
 * #749: the five hardening controls must survive the round trip, and must be
 * turn-off-able.
 *
 * The sibling of `namespaces-survive-deploy.test.ts`, and it exists for the same
 * reason: every layer between the parser and the runtime is a hand-written field
 * list, so a value is preserved only where someone remembered it. Riding inside
 * the `advanced` JSONB blob is what lets these five inherit that file's fixes, and
 * these cases prove they actually do rather than assuming it.
 *
 * The one behaviour worth its own proof is REMOVAL, because for hardening it is
 * the ONLY way to turn a control off. The parser deliberately never stores
 * `read_only: false` or `cap_drop: []` (see compose-hardening.ts: `docker compose
 * config` erases both keys, so storing them would make the two import doors
 * disagree about the same file), which means "no longer read-only" is expressed
 * purely by the key being absent. That only works if `readOnly` is compose-OWNED,
 * and only when the caller is the file itself: half of `syncFromCompose`'s callers
 * pass a release's frozen snapshot, which travels through a wire schema with no
 * `advanced` at all, and reading that silence as a deletion would strip the
 * hardening off every service on the next deploy.
 */

import { repos } from "@repo/db";
import { composeSpecDiff, composeSpecsEqual, toComposeSpec } from "@repo/db";
import type { ComposeAdvanced } from "@repo/core";
import { beforeEach, describe, expect, it } from "vitest";

import { projectServicesToDeployableServices } from "../../../src/modules/deployments/compose/project-services";
import { seedOrg, seedProject, seedService } from "../../helpers/seed";

/** The OWASP set, as the parser stores it. */
const HARDENING: ComposeAdvanced = {
  readOnly: true,
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges:true"],
  tmpfs: ["/run:size=64m,mode=1777"],
  user: "1000:1000",
};

const parsedHardened = (name: string) => ({
  name,
  image: "nginx:alpine",
  ports: [] as string[],
  dependsOn: [] as string[],
  environment: {},
  volumes: [] as string[],
  advanced: { ...HARDENING },
});

/** The same service after the author deleted all five lines from the YAML. */
const parsedPlain = (name: string) => {
  const { advanced: _drop, ...rest } = parsedHardened(name);
  return rest;
};

describe("compose hardening survives a deploy", () => {
  let projectId: string;

  beforeEach(async () => {
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, { framework: "docker-compose" });
    projectId = project.id;
  });

  it("persists all five, and reads back exactly what it wrote", async () => {
    const [created] = await repos.service.syncFromCompose(projectId, [parsedHardened("web")]);
    expect(created!.advanced).toMatchObject(HARDENING);
    const persisted = await repos.service.findById(created!.id);
    expect(persisted?.advanced).toEqual(created!.advanced);
  });

  it("keeps the controls when the caller is a frozen snapshot, not the file", async () => {
    // The deploy path. `BuildServiceInput` cannot carry `advanced`, so the snapshot
    // arrives silent about it, and silence there is not a deletion. Reading it as
    // one would quietly unharden every service on its next redeploy.
    const stored = await seedService(projectId, {
      name: "web",
      image: "nginx:alpine",
      advanced: { ...HARDENING },
    });

    await repos.service.syncFromCompose(projectId, [parsedPlain("web")], {
      removeMissing: false,
    });

    expect((await repos.service.findById(stored.id))?.advanced).toMatchObject(HARDENING);
  });

  it("clears every control when the file itself stops asking", async () => {
    // The only way to un-harden a service: the payload IS the compose file, so a
    // missing `read_only:` was removed by the author and the root filesystem has
    // to come back writable.
    const stored = await seedService(projectId, {
      name: "web",
      image: "nginx:alpine",
      advanced: { ...HARDENING, readiness: { enabled: true } },
    });

    await repos.service.syncFromCompose(projectId, [parsedPlain("web")], {
      composeAuthoritative: true,
    });

    const after = await repos.service.findById(stored.id);
    expect(after?.advanced?.readOnly).toBeUndefined();
    expect(after?.advanced?.capDrop).toBeUndefined();
    expect(after?.advanced?.securityOpt).toBeUndefined();
    expect(after?.advanced?.tmpfs).toBeUndefined();
    expect(after?.advanced?.user).toBeUndefined();
    // Only the compose-owned keys clear. A readiness gate compose cannot express
    // must not be collateral.
    expect(after?.advanced?.readiness).toEqual({ enabled: true });
  });

  it("carries the controls into the projection a rollback replays", async () => {
    const stored = await seedService(projectId, {
      name: "web",
      image: "nginx:alpine",
      advanced: { ...HARDENING },
    });
    const [projected] = projectServicesToDeployableServices([stored]);
    expect(projected!.advanced).toMatchObject(HARDENING);
  });

  it("reads a weakened hardening request as drift rather than 'repo unchanged'", async () => {
    // If the comparison were blind to it, reconcileFromCompose would decide the
    // repo hadn't changed and the container would keep the OLD capability set,
    // which is the exact direction that must never pass unnoticed.
    const base = toComposeSpec({ image: "nginx:alpine", advanced: { ...HARDENING } });
    const next = toComposeSpec({
      image: "nginx:alpine",
      advanced: { ...HARDENING, capDrop: ["NET_RAW"] },
    });
    expect(composeSpecsEqual(base, next)).toBe(false);
    expect(composeSpecDiff(base, next).map((c) => c.field)).toContain("advanced");
  });
});
