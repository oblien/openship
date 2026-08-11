import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNetworkAliases } from "@repo/adapters";
import { serviceAliasExtras } from "../../../src/lib/deployable-service";

/**
 * A migration that ATTACHES a running container in place has to leave it
 * addressable exactly like a natively-deployed one: same project network, same
 * DNS alias set. It used to get only its row name — so a service whose operator
 * had set a custom east-west alias resolved for deployed services and silently
 * did not for reused ones.
 */

const joinServiceGroupContainers = vi.hoisted(() => vi.fn());
const dispose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const createServerDockerRuntime = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/deployment-runtime")>();
  return { ...actual, createServerDockerRuntime };
});

const { joinReusedContainersToGroup } = await import("../../../src/modules/migration/migrate.service");

const discovered = (name: string, containerId: string) =>
  ({ name, containerId, source: "container", running: true, ports: [], env: {}, volumes: [], networks: [], dependsOn: [], warnings: [] }) as never;

const row = (name: string, advanced?: { alias?: string }) =>
  ({ id: `svc_${name}`, name, advanced: advanced ?? null }) as never;

/** members[] as the runtime was asked to join them. */
const joinedMembers = () => joinServiceGroupContainers.mock.calls.at(-1)?.[1] as Array<{ containerId: string; aliases: string[] }>;

describe("serviceAliasExtras — the ONE custom-alias rule", () => {
  it("returns the normalized custom alias", () => {
    expect(serviceAliasExtras({ name: "postgres", advanced: { alias: "db" } })).toEqual(["db"]);
  });

  it("returns nothing when unset", () => {
    expect(serviceAliasExtras({ name: "postgres" })).toBeUndefined();
    expect(serviceAliasExtras({ name: "postgres", advanced: null })).toBeUndefined();
  });

  it("returns nothing when the alias collapses to the service's own name", () => {
    // The primary alias already covers it — a duplicate would be a no-op.
    expect(serviceAliasExtras({ name: "postgres", advanced: { alias: "postgres" } })).toBeUndefined();
  });

  it("composes into the same alias list a deployed container gets", () => {
    expect(buildNetworkAliases("postgres", serviceAliasExtras({ name: "postgres", advanced: { alias: "db" } }))).toEqual([
      "postgres",
      "db",
    ]);
  });
});

describe("joinReusedContainersToGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createServerDockerRuntime.mockResolvedValue({ joinServiceGroupContainers, dispose });
  });

  it("joins a reused container under its row name AND its custom alias", async () => {
    await joinReusedContainersToGroup({
      serverId: "srv_1",
      organizationId: "org_1",
      slug: "acme",
      attach: [discovered("postgres", "container_pg")],
      serviceRows: [row("postgres", { alias: "db" })],
    });

    expect(joinServiceGroupContainers).toHaveBeenCalledWith("acme", [
      { containerId: "container_pg", aliases: ["postgres", "db"] },
    ]);
  });

  it("joins under just the row name when no custom alias is set", async () => {
    await joinReusedContainersToGroup({
      serverId: "srv_1",
      organizationId: "org_1",
      slug: "acme",
      attach: [discovered("postgres", "container_pg")],
      serviceRows: [row("postgres")],
    });

    expect(joinedMembers()).toEqual([{ containerId: "container_pg", aliases: ["postgres"] }]);
  });

  it("matches renamed rows through the rename map", async () => {
    // The row is keyed by its final (repo) name; the container by its discovered
    // one — without the map a renamed service silently joins nothing.
    await joinReusedContainersToGroup({
      serverId: "srv_1",
      organizationId: "org_1",
      slug: "acme",
      attach: [discovered("pg", "container_pg")],
      serviceRows: [row("postgres", { alias: "db" })],
      renames: { pg: "postgres" },
    });

    expect(joinedMembers()).toEqual([{ containerId: "container_pg", aliases: ["postgres", "db"] }]);
  });

  it("skips a discovered service with no container id", async () => {
    await joinReusedContainersToGroup({
      serverId: "srv_1",
      organizationId: "org_1",
      slug: "acme",
      attach: [discovered("postgres", "")],
      serviceRows: [row("postgres")],
    });

    expect(joinedMembers()).toEqual([]);
  });

  it("releases the runtime it opened", async () => {
    await joinReusedContainersToGroup({
      serverId: "srv_1",
      organizationId: "org_1",
      slug: "acme",
      attach: [discovered("postgres", "container_pg")],
      serviceRows: [row("postgres")],
    });

    expect(dispose).toHaveBeenCalled();
  });

  it("no-ops without a slug rather than joining a nameless network", async () => {
    await joinReusedContainersToGroup({
      serverId: "srv_1",
      organizationId: "org_1",
      slug: "",
      attach: [discovered("postgres", "container_pg")],
      serviceRows: [row("postgres")],
    });

    expect(createServerDockerRuntime).not.toHaveBeenCalled();
  });
});
