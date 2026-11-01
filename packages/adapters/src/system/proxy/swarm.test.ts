import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../../types";
import { probeEdge, freeEdgeTargets } from "./detect";
import { beginEdgeTakeover } from "./takeover-journal";
import { stopContainerDurably } from "../port-owner";
import { swarmEdgePorts } from "./swarm";
import { portStopVerdict, resolvePortOwner } from "../../runtime/port-conflict";

const cid = "a".repeat(64);
function host({
  state = "active",
  manager = true,
  services = "*:80->8080/tcp, *:443->8443/tcp",
  labels = {} as Record<string, string>,
} = {}) {
  const exec = vi.fn(async (command: string) => {
    if (command.includes("{{json .Swarm}}"))
      return JSON.stringify({ LocalNodeState: state, ControlAvailable: manager });
    if (command.startsWith("docker service ls"))
      return JSON.stringify({ Name: "shop_proxy", Ports: services });
    if (command.includes("{{json .Id}} {{json .Config.Labels}}"))
      return `"${cid}" ${JSON.stringify(labels)}`;
    return "";
  });
  return { exec, executor: { exec } as unknown as CommandExecutor };
}
const writes = (commands: string[]) =>
  commands.filter((command) =>
    /docker (?:stop|update|rm|start)|systemctl (?:stop|disable)|\bkill\b|tee |mkdir/.test(command),
  );

describe("Swarm ownership during standalone Edge setup", () => {
  it("finds ingress ports without local containers or sockets and refuses takeover before its journal", async () => {
    const h = host();
    const status = await probeEdge(h.executor);
    expect(status).toMatchObject({
      canProceedClean: false,
      occupants: [
        { port: 80, swarmService: "shop_proxy" },
        { port: 443, swarmService: "shop_proxy" },
      ],
    });
    await expect(beginEdgeTakeover(h.executor, status, () => {})).rejects.toMatchObject({
      code: "SWARM_SERVICE_OWNED",
    });
    expect(writes(h.exec.mock.calls.map(([command]) => command))).toEqual([]);
  });
  it("reads published ingress ports, ignoring container target ports and non-TCP mappings", async () => {
    expect(
      await swarmEdgePorts(host({ services: "*:8080->80/tcp, *:443->443/udp" }).executor),
    ).toEqual(new Map());
    expect(await swarmEdgePorts(host({ services: "*:79-81->8079-8081/tcp" }).executor)).toEqual(
      new Map([[80, "shop_proxy"]]),
    );
  });
  it("does not claim worker ingress is free or run manager-only requests against a worker", async () => {
    const h = host({ manager: false });
    expect((await probeEdge(h.executor)).canProceedClean).toBe(false);
    await expect(
      freeEdgeTargets(h.executor, [{ port: 80, unit: "nginx.service" }], () => {}),
    ).rejects.toMatchObject({ code: "SWARM_SERVICE_OWNED" });
    expect(h.exec.mock.calls.some(([command]) => command.startsWith("docker service"))).toBe(false);
    expect(writes(h.exec.mock.calls.map(([command]) => command))).toEqual([]);
  });
  it("refuses a stale policy before stopping its first owner when another target is a Swarm task", async () => {
    const h = host({
      state: "inactive",
      labels: { "com.docker.swarm.service.name": "shop_proxy" },
    });
    await expect(
      freeEdgeTargets(h.executor, [{ unit: "nginx.service" }, { container: "task" }], () => {}),
    ).rejects.toMatchObject({ code: "SWARM_SERVICE_OWNED" });
    expect(writes(h.exec.mock.calls.map(([command]) => command))).toEqual([]);
  });
  it("does not leave a recovery journal when fresh ownership invalidates an old takeover preview", async () => {
    const h = host({
      state: "inactive",
      labels: { "com.docker.swarm.task.id": "new-task" },
    });
    const writeFile = vi.fn(),
      mkdir = vi.fn();
    Object.assign(h.executor, { writeFile, mkdir });
    await expect(
      beginEdgeTakeover(
        h.executor,
        {
          canProceedClean: false,
          occupants: [{ port: 80, containerName: "proxy", managedByOpenship: false }],
        } as Parameters<typeof beginEdgeTakeover>[1],
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "SWARM_SERVICE_OWNED",
    });
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writes(h.exec.mock.calls.map(([command]) => command))).toEqual([]);
  });
  it("does not mutate when Docker ownership cannot be read", async () => {
    const h = host({ state: "inactive" });
    h.exec.mockImplementation(async (command) => {
      if (command.includes("{{json .Swarm}}")) return '{"LocalNodeState":"inactive"}';
      throw new Error("Docker connection lost");
    });
    await expect(
      freeEdgeTargets(h.executor, [{ unit: "nginx.service" }, { container: "proxy" }], () => {}),
    ).rejects.toThrow("Docker connection lost");
    expect(writes(h.exec.mock.calls.map(([command]) => command))).toEqual([]);
  });
  it("uses the inspected ID when stopping an ordinary container, never a reused name", async () => {
    const h = host({ state: "inactive" });
    await stopContainerDurably(h.executor, "proxy");
    expect(writes(h.exec.mock.calls.map(([command]) => command))).toEqual([
      `docker update --restart=no '${cid}' 2>/dev/null || true`,
      `docker stop '${cid}' 2>/dev/null || true`,
    ]);
  });
  it("never offers a Swarm task as a standalone port-stop target, including Openship-labelled tasks", async () => {
    const h = host({ state: "inactive" });
    const original = h.exec.getMockImplementation()!;
    h.exec.mockImplementation(async (command) =>
      command.includes("--filter publish=8080")
        ? [
            cid,
            "shop_web.1.task",
            "nginx:1.28",
            "proj_old",
            "dep_old",
            "web",
            "",
            "",
            "",
            "shop_web",
          ].join("\t")
        : original(command),
    );
    const occupant = await resolvePortOwner(h.executor, 8080);
    expect(occupant?.swarmService).toBe("shop_web");
    expect(portStopVerdict(occupant!)).toEqual({ target: "none", why: "swarm" });
  });
});
