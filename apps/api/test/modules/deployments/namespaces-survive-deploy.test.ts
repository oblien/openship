/**
 * #533: compose `network_mode` / `pid` must survive the round trip — storage,
 * the frozen release snapshot, and the drift comparison.
 *
 * The sibling of `advanced-survives-deploy.test.ts`, and the same failure shape:
 * every layer between the parser and the runtime is a hand-written field list, so
 * a value is preserved only where someone remembered it. Namespaces ride inside
 * the `advanced` JSONB blob precisely so they inherit that file's fixes — these
 * cases prove they actually do, and pin the one behaviour that differs.
 *
 * That difference is REMOVAL. `mergeAdvanced` treats an absent key as "the parser
 * had nothing to say", which is right for a readiness gate or an app template's
 * generated files (compose has no syntax for them) and wrong for a namespace:
 * nothing but the compose file sets one, so absence means the author deleted it,
 * and keeping it would pin the container into a namespace the file no longer asks
 * for. But only a caller that just re-read the FILE may draw that conclusion —
 * half of syncFromCompose's callers pass a release's frozen snapshot, which
 * travels through a wire schema (`BuildServiceInput`) with no `advanced` field at
 * all. Treating that silence as a deletion would wipe the namespace on the next
 * deploy, so the clearing is opt-in per caller.
 */

import { repos } from "@repo/db";
import { composeSpecDiff, composeSpecsEqual, toComposeSpec } from "@repo/db";
import type { ComposeAdvanced } from "@repo/core";
import { beforeEach, describe, expect, it } from "vitest";

import { projectServicesToDeployableServices } from "../../../src/modules/deployments/compose/project-services";
import { seedOrg, seedProject, seedService } from "../../helpers/seed";

const NAMESPACES: ComposeAdvanced = {
  networkMode: "service:gluetun",
  pidMode: "service:gluetun",
};

/** What the parser produces for a service declaring both keys. */
const parsedWithNamespaces = (name: string) => ({
  name,
  image: "linuxserver/qbittorrent",
  ports: [] as string[],
  dependsOn: [] as string[],
  environment: {},
  volumes: [] as string[],
  advanced: { ...NAMESPACES },
});

/** The same service after the author deleted both lines from the YAML. */
const parsedWithout = (name: string) => {
  const { advanced: _drop, ...rest } = parsedWithNamespaces(name);
  return rest;
};

describe("compose namespaces survive a deploy", () => {
  let projectId: string;

  beforeEach(async () => {
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, { framework: "docker-compose" });
    projectId = project.id;
  });

  describe("storage", () => {
    it("persists both keys on the create branch", async () => {
      const [created] = await repos.service.syncFromCompose(projectId, [
        parsedWithNamespaces("qbit"),
      ]);
      expect(created!.advanced).toMatchObject(NAMESPACES);
      expect((await repos.service.findById(created!.id))?.advanced).toMatchObject(NAMESPACES);
    });

    it("persists both keys on the update branch", async () => {
      const stored = await seedService(projectId, { name: "qbit", image: "old" });
      await repos.service.syncFromCompose(projectId, [parsedWithNamespaces("qbit")]);
      expect((await repos.service.findById(stored.id))?.advanced).toMatchObject(NAMESPACES);
    });

    it("keeps the value when the caller is a frozen snapshot, not the file", async () => {
      // The deploy path. `BuildServiceInput` cannot carry `advanced`, so the
      // snapshot arrives silent about it — and silence here is not a deletion.
      const stored = await seedService(projectId, {
        name: "qbit",
        image: "linuxserver/qbittorrent",
        advanced: { ...NAMESPACES },
      });

      await repos.service.syncFromCompose(projectId, [parsedWithout("qbit")], {
        removeMissing: false,
      });

      expect((await repos.service.findById(stored.id))?.advanced).toMatchObject(NAMESPACES);
    });

    it("clears the value when the caller IS the file and the key is gone", async () => {
      // `openship service sync` / an authoritative import: the payload is the full
      // compose file, so a missing `network_mode` was removed by the author.
      const stored = await seedService(projectId, {
        name: "qbit",
        image: "linuxserver/qbittorrent",
        advanced: { ...NAMESPACES, readiness: { enabled: true } },
      });

      await repos.service.syncFromCompose(projectId, [parsedWithout("qbit")], {
        composeAuthoritative: true,
      });

      const after = await repos.service.findById(stored.id);
      expect(after?.advanced?.networkMode).toBeUndefined();
      expect(after?.advanced?.pidMode).toBeUndefined();
      // Only the compose-owned keys clear — a readiness gate compose cannot
      // express must not be collateral.
      expect(after?.advanced?.readiness).toEqual({ enabled: true });
    });

    it("replaces a changed value on an authoritative sync", async () => {
      const stored = await seedService(projectId, {
        name: "qbit",
        image: "linuxserver/qbittorrent",
        advanced: { networkMode: "service:oldvpn" },
      });

      await repos.service.syncFromCompose(
        projectId,
        [{ ...parsedWithout("qbit"), advanced: { networkMode: "service:gluetun" } }],
        { composeAuthoritative: true },
      );

      expect((await repos.service.findById(stored.id))?.advanced?.networkMode).toBe(
        "service:gluetun",
      );
    });

    it("returns rows that agree with what was written", async () => {
      await seedService(projectId, { name: "qbit", image: "old" });
      const [returned] = await repos.service.syncFromCompose(projectId, [
        parsedWithNamespaces("qbit"),
      ]);
      const persisted = await repos.service.findById(returned!.id);
      expect(returned!.advanced).toEqual(persisted?.advanced);
    });
  });

  describe("snapshot (what a rollback replays)", () => {
    it("captures both keys into the deployable projection", async () => {
      const stored = await seedService(projectId, {
        name: "qbit",
        image: "linuxserver/qbittorrent",
        advanced: { ...NAMESPACES },
      });
      const [projected] = projectServicesToDeployableServices([stored]);
      expect(projected!.advanced).toMatchObject(NAMESPACES);
    });
  });

  describe("drift", () => {
    it("an added namespace is not read as 'repo unchanged'", async () => {
      // If the comparison were blind to it, reconcileFromCompose would decide the
      // repo hadn't changed and never apply the new mode.
      const base = toComposeSpec({ image: "linuxserver/qbittorrent" });
      const next = toComposeSpec({
        image: "linuxserver/qbittorrent",
        advanced: { ...NAMESPACES },
      });
      expect(composeSpecsEqual(base, next)).toBe(false);
      expect(composeSpecDiff(base, next).map((c) => c.field)).toContain("advanced");
    });

    it("a CHANGED provider is drift", async () => {
      const base = toComposeSpec({ advanced: { networkMode: "service:oldvpn" } });
      const next = toComposeSpec({ advanced: { networkMode: "service:gluetun" } });
      expect(composeSpecsEqual(base, next)).toBe(false);
    });

    it("an unchanged namespace is not phantom drift", async () => {
      const a = toComposeSpec({ advanced: { networkMode: "service:vpn", pidMode: "service:vpn" } });
      // Same content, keys written in the other order — canonicalization must sort.
      const b = toComposeSpec({ advanced: { pidMode: "service:vpn", networkMode: "service:vpn" } });
      expect(composeSpecsEqual(a, b)).toBe(true);
    });
  });
});
