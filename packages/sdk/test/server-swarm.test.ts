import { expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { swarmFixture } from "../../contracts/test/swarm-fixture";

it("inspects through the shared server facade with escaped ID and validated optional query", async () => {
  const fetcher = vi.fn(async () => Response.json(swarmFixture()));
  const ship = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
  expect(await ship.servers.inspectSwarm("manager/a", { details: true })).toEqual(swarmFixture());
  expect(fetcher).toHaveBeenCalledWith(
    "https://ship.test/api/system/servers/manager%2Fa/swarm?details=true",
    expect.objectContaining({ method: "GET" }),
  );
  await ship.servers.inspectSwarm("manager/a");
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://ship.test/api/system/servers/manager%2Fa/swarm",
    expect.objectContaining({ method: "GET" }),
  );
  await expect(
    ship.servers.inspectSwarm("manager/a", { details: "yes" } as never),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("connects with a retry identity through the SDK server facade and rejects extra mutation fields", async () => {
  const cluster = {
    id: "cluster",
    name: "Production",
    revision: 1,
    location: null,
    networkId: null,
    network: null,
    serverIds: ["manager/a"],
    scaling: { provider: "swarm", status: "ready", verifiedAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const fetcher = vi.fn(async () => Response.json(cluster));
  const ship = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
  const input = { name: "Production", requestId: "retry-identity-123456" };
  expect(await ship.servers.connectSwarm("manager/a", input)).toEqual(cluster);
  expect(fetcher).toHaveBeenCalledWith(
    "https://ship.test/api/system/servers/manager%2Fa/swarm/connect",
    expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
  );
  await expect(
    ship.servers.connectSwarm("manager/a", { ...input, force: true } as never),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
