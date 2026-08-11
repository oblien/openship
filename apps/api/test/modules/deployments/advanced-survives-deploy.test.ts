/**
 * D4: the `advanced` JSONB blob (healthcheck / readiness / generated files /
 * resource caps / east-west alias) was erased by every deploy that carried
 * compose services, and it never made it into the frozen release snapshot.
 *
 * Two independent halves, both required — either one alone still loses the blob:
 *
 *   STORAGE   `toComposeSpec` coerces a missing `advanced` to `{}` (correct for
 *             the drift comparison it exists for, destructive as a write) and
 *             `syncFromCompose` fed that straight to `.set()`. Compose YAML has
 *             no syntax for a readiness gate, generated files, resource caps or
 *             an alias, so the parser always supplies nothing and the stored
 *             blob was overwritten with `{}`.
 *
 *   SNAPSHOT  `projectServicesToDeployableServices` never projected `advanced`,
 *             so `deployment.meta.composeServices` — the list a rollback
 *             replays — was frozen without it. Even with storage fixed, a
 *             rollback could not restore the release's healthcheck or alias
 *             because they were never captured.
 */

import { repos, type Service } from "@repo/db";
import { composeSpecsEqual, toComposeSpec } from "@repo/db";
import type { ComposeAdvanced } from "@repo/core";
import { beforeEach, describe, expect, it } from "vitest";

import { projectServicesToDeployableServices } from "../../../src/modules/deployments/compose/project-services";
import { seedOrg, seedProject, seedService } from "../../helpers/seed";

/** Every key of the blob, so a partial write shows up as a specific loss. */
const FULL_ADVANCED: ComposeAdvanced = {
  healthcheck: { test: ["CMD", "pg_isready"], interval: "10s", retries: 3 },
  readiness: { enabled: true, path: "/healthz", timeoutSeconds: 30 },
  files: [{ path: "/etc/kong/kong.yml", content: "_format_version: '3.0'\n" }],
  resources: { cpuCores: 2, memoryMb: 4096 },
  alias: "db",
};

/** What the compose parser produces for that service: no `advanced` at all. */
const parsedFromYaml = (name: string) => ({
  name,
  image: "postgres:16-alpine",
  ports: ["5432:5432"],
  dependsOn: [],
  environment: { POSTGRES_PASSWORD: "s3cret" },
  volumes: ["data:/var/lib/postgresql/data"],
});

describe("the advanced blob survives a deploy", () => {
  let projectId: string;

  beforeEach(async () => {
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, { framework: "docker-compose" });
    projectId = project.id;
  });

  describe("storage (syncFromCompose)", () => {
    it("keeps the stored blob when the parsed service carries none", async () => {
      const stored = await seedService(projectId, {
        name: "db",
        image: "postgres:16-alpine",
        advanced: FULL_ADVANCED,
      });

      await repos.service.syncFromCompose(projectId, [parsedFromYaml("db")]);

      const after = await repos.service.findById(stored.id);
      expect(after?.advanced).toEqual(FULL_ADVANCED);
    });

    it("merges per key rather than replacing the whole blob", async () => {
      const stored = await seedService(projectId, {
        name: "db",
        image: "postgres:16-alpine",
        advanced: FULL_ADVANCED,
      });

      // A compose file that DOES declare a healthcheck: that key wins, the four
      // keys compose cannot express are left alone.
      await repos.service.syncFromCompose(projectId, [
        {
          ...parsedFromYaml("db"),
          advanced: { healthcheck: { test: ["CMD", "true"], interval: "5s" } },
        },
      ]);

      const after = await repos.service.findById(stored.id);
      expect(after?.advanced).toEqual({
        ...FULL_ADVANCED,
        healthcheck: { test: ["CMD", "true"], interval: "5s" },
      });
    });

    it("still clears the blob on an explicit null", async () => {
      const stored = await seedService(projectId, {
        name: "db",
        image: "postgres:16-alpine",
        advanced: FULL_ADVANCED,
      });

      await repos.service.syncFromCompose(projectId, [
        { ...parsedFromYaml("db"), advanced: null } as never,
      ]);

      const after = await repos.service.findById(stored.id);
      expect(after?.advanced).toEqual({});
    });

    it("returns rows that agree with what was written", async () => {
      // The update branch echoes a synthesized row rather than re-reading. If the
      // write and the echo are computed separately they drift, and every caller
      // that trusts the return value (the deploy pipeline does) sees a blob the
      // database does not have.
      await seedService(projectId, {
        name: "db",
        image: "postgres:16-alpine",
        advanced: FULL_ADVANCED,
      });

      const [returned] = await repos.service.syncFromCompose(projectId, [
        parsedFromYaml("db"),
      ]);

      const persisted = await repos.service.findById(returned!.id);
      expect(returned!.advanced).toEqual(persisted?.advanced);
      expect(returned!.advanced).toEqual(FULL_ADVANCED);
    });

    it("carries the blob onto a row the sync has to recreate", async () => {
      // A rollback to a release containing a since-deleted service goes through
      // the create branch, which is where the frozen snapshot's blob lands.
      const [created] = await repos.service.syncFromCompose(projectId, [
        { ...parsedFromYaml("db"), advanced: FULL_ADVANCED },
      ]);

      expect(created!.advanced).toEqual(FULL_ADVANCED);
      expect((await repos.service.findById(created!.id))?.advanced).toEqual(FULL_ADVANCED);
    });

    it("leaves drift canonicalization alone", async () => {
      // The merge lives on the write path only. `toComposeSpec` must keep
      // coercing to `{}` or a stored `{}` and an absent blob would read as drift
      // the operator cannot resolve.
      expect(
        composeSpecsEqual(
          toComposeSpec({ image: "x" }),
          toComposeSpec({ image: "x", advanced: {} }),
        ),
      ).toBe(true);
    });
  });

  describe("snapshot (projectServicesToDeployableServices)", () => {
    it("projects the blob into the frozen release list", () => {
      const row = {
        id: "svc_1",
        name: "db",
        kind: "compose",
        enabled: true,
        image: "postgres:16-alpine",
        ports: ["5432:5432"],
        dependsOn: [],
        environment: {},
        volumes: [],
        advanced: FULL_ADVANCED,
      } as unknown as Service;

      const [projected] = projectServicesToDeployableServices([row]);

      expect(projected!.advanced).toEqual(FULL_ADVANCED);
    });

    it("projects undefined, not {}, when the row has no blob", () => {
      // `{}` here would defeat the merge on the way back in: an empty object is
      // a real patch that clears nothing but proves nothing either, whereas
      // `undefined` is what tells mergeAdvanced "leave the stored value alone".
      const row = {
        id: "svc_1",
        name: "web",
        kind: "compose",
        enabled: true,
        image: "nginx",
        ports: [],
        dependsOn: [],
        environment: {},
        volumes: [],
        advanced: null,
      } as unknown as Service;

      const [projected] = projectServicesToDeployableServices([row]);

      expect(projected!.advanced).toBeUndefined();
    });

    it("round-trips: snapshot a live row, replay it, blob intact", async () => {
      // The full rollback shape — project the row the way the pipeline freezes
      // it, then feed that frozen list back through the sync the way a rollback
      // does. Before the fix this pair lost the blob twice over.
      const stored = await seedService(projectId, {
        name: "db",
        image: "postgres:16-alpine",
        advanced: FULL_ADVANCED,
      });

      const frozen = projectServicesToDeployableServices([stored]);

      // Operator edits the alias after the release, then rolls back.
      await repos.service.update(stored.id, {
        advanced: { ...FULL_ADVANCED, alias: "primary" },
      });
      await repos.service.syncFromCompose(projectId, frozen);

      const after = await repos.service.findById(stored.id);
      expect(after?.advanced).toEqual(FULL_ADVANCED);
    });
  });
});
