import { describe, expect, it } from "vitest";
import { changedSwarmVolumeIdentities, claimVolumeIdentityMismatches, swarmResourceIdentities, swarmVolumeReplacementAcknowledgementKey } from "./swarm-resource-identities";

describe("Swarm resource identities", () => {
  it("uses Docker Stack namespace rules while preserving explicit and external names", () => {
    const resources = swarmResourceIdentities(`volumes:
  data: { driver: local }
  postgres: { name: production-postgres, external: true }
networks:
  default: {}
  frontend: { name: shared-frontend, external: true, driver: overlay }
`, "blog");
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "volume", logicalName: "data", effectiveName: "blog_data", external: false, driver: "local" }),
      expect.objectContaining({ kind: "volume", logicalName: "postgres", effectiveName: "production-postgres", external: true }),
      expect.objectContaining({ kind: "network", logicalName: "default", effectiveName: "blog_default", external: false }),
      expect.objectContaining({ kind: "network", logicalName: "frontend", effectiveName: "shared-frontend", external: true, driver: "overlay" }),
    ]));
  });

  it("flags a first-claim source that redirects an attached volume to a different effective name", () => {
    const mismatches = claimVolumeIdentityMismatches(`services:
  database:
    image: postgres
    volumes: [database:/var/lib/postgresql/data]
volumes:
  database: { name: replacement-db, external: true }
`, "blog", [{ sourceServiceName: "database", volumes: ["production-db"] } as never]);
    expect(mismatches).toEqual([{
      serviceName: "database", logicalName: "database", previousName: "production-db", nextName: "replacement-db",
    }]);
  });

  it("reports a stateful volume identity replacement but not stable driver-option edits", () => {
    const previous = `volumes:\n  database: { name: production-db, external: true, driver: local }\n`;
    const changed = changedSwarmVolumeIdentities(previous, `volumes:\n  database: { name: replacement-db, external: true, driver: local }\n`, "blog");
    expect(changed).toEqual([{ logicalName: "database", previousName: "production-db", nextName: "replacement-db" }]);
    expect(swarmVolumeReplacementAcknowledgementKey(changed[0]!)).toBe("database:production-db:replacement-db");
    expect(changedSwarmVolumeIdentities(previous, `volumes:\n  database: { name: production-db, external: true, driver: local, driver_opts: { type: nfs } }\n`, "blog"))
      .toEqual([]);
  });
});
