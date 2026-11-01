import { describe, expect, it } from "vitest";
import type Dockerode from "dockerode";
import { assertSwarmServiceConfig, swarmContainerSpec, swarmGatewayPorts } from "./spec";
import type { MultiServiceDeployConfig } from "../types";
const config = (): MultiServiceDeployConfig => ({
  projectId: "p",
  deploymentId: "d",
  slug: "app",
  serviceName: "web",
  image: "web@sha256:abc",
  ports: ["8080", "127.0.0.1:5353:53/udp"],
  environment: { TOKEN: "private" },
  volumes: [],
  namespaceVolumes: true,
});
const image = {
  Config: { Entrypoint: ["/wrapper"], Cmd: ["serve", "--default"] },
} as Dockerode.ImageInspectInfo;
describe("Swarm preserves the shared service contract", () => {
  it("keeps image defaults, explicit argv and clearing the entrypoint distinct", () => {
    expect(swarmContainerSpec(config(), image)).not.toHaveProperty("Command");
    expect(swarmContainerSpec(config(), image)).not.toHaveProperty("Args");
    expect(
      swarmContainerSpec({ ...config(), commandArgv: ["echo", "$TOKEN"] }, image).Args,
    ).toEqual(["echo", "$TOKEN"]);
    expect(
      swarmContainerSpec(
        { ...config(), commandArgv: [], advanced: { entrypoint: ["/custom"] } },
        image,
      ),
    ).toMatchObject({ Command: ["/custom"], Args: [] });
    expect(swarmContainerSpec({ ...config(), advanced: { entrypoint: [] } }, image)).toMatchObject({
      Command: ["serve"],
      Args: ["--default"],
    });
    expect(swarmContainerSpec(config(), image).Env).toEqual(["TOKEN=private"]);
  });
  it("preserves private TCP/UDP bindings and all route ports without publishing Swarm ingress", () => {
    const result = swarmGatewayPorts({ ...config(), publicPort: 3000, routedPorts: [4000] });
    expect(result.portBindings).toEqual({
      "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
      "53/udp": [{ HostIp: "127.0.0.1", HostPort: "5353" }],
    });
    expect(result.ports).toEqual(["3000/tcp", "4000/tcp", "53/udp", "8080/tcp"]);
  });
  it.each([
    { advanced: { networkMode: "service:db" } },
    { advanced: { gpus: "all" } },
    { resources: { memoryMb: 512, swapDisabled: true } },
    { advanced: { resources: { memoryMb: 512, swapDisabled: true } } },
    { advanced: { extraHosts: { host: "host-gateway" } } },
    { ports: ["8080:8081-8085"] },
    { ports: ["70000"] },
    { volumes: ["/host/data:/data"] },
    { volumes: ["data:/data:Z"] },
    { advanced: { files: [{ path: "../private", content: "secret" }] } },
    {
      advanced: {
        files: [
          { path: "/etc/app", content: "a" },
          { path: "/etc/app", content: "b" },
        ],
      },
    },
  ])("refuses unsupported scheduling inputs before deployment: %j", (extra) => {
    expect(() =>
      assertSwarmServiceConfig({ ...config(), ...extra } as MultiServiceDeployConfig),
    ).toThrow();
  });
});
