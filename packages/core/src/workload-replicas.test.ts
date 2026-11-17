import { describe, expect, it } from "vitest";
import {
  assertWorkloadReplicas,
  assertWorkloadReplicaTopology,
  readComposeExposedPorts,
  readComposeReplicas,
} from "./workload-replicas";

describe("workload replica admission", () => {
  it("leaves omitted counts inherited and normalizes both Compose forms", () => {
    expect(readComposeReplicas({})).toBeUndefined();
    expect(readComposeReplicas({ scale: 3 })).toBe(3);
    expect(readComposeReplicas({ deploy: { replicas: "${COUNT}" } }, () => "4")).toBe(4);
    expect(readComposeReplicas({ scale: 2, deploy: { replicas: "2" } })).toBe(2);
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity, "NaN", "1e2", true, null])(
    "refuses invalid counts: %s",
    (count) => {
      expect(() => readComposeReplicas({ scale: count })).toThrow();
    },
  );
  it("refuses conflicting counts, fixed names and nonreplicated modes", () => {
    expect(() => readComposeReplicas({ scale: 2, deploy: { replicas: 3 } })).toThrow(/agree/);
    expect(() => readComposeReplicas({ scale: 2, container_name: "api" })).toThrow(
      /container_name/,
    );
    expect(() => readComposeReplicas({ deploy: { replicas: 2, mode: "global" } })).toThrow(/mode/);
  });
  it.each([
    { image: "postgres:17" },
    { framework: "redis" },
    { volumes: ["data:/data"] },
    { volumes: ["/data"] },
    { volumes: ["/srv:/app:rw"] },
    { controlPlane: true },
    { workload: "static" },
    { advanced: { networkMode: "host" } },
    { advanced: { pidMode: "host" } },
    { advanced: { runtime: "nvidia" } },
  ])("refuses unsafe copies but preserves the singleton configuration", (configuration) => {
    expect(() => assertWorkloadReplicas(2, configuration as never)).toThrow();
    expect(() => assertWorkloadReplicas(1, configuration as never)).not.toThrow();
  });
  it("allows independent stateless copies with read-only mounts", () => {
    expect(() =>
      assertWorkloadReplicas(3, { image: "team/api:latest", volumes: ["/srv/config:/config:ro"] }),
    ).not.toThrow();
  });
  it("refuses shared namespace dependents of a replicated workload", () => {
    const services = [
      { name: "api", replicas: 3 },
      { name: "sidecar", advanced: { networkMode: "service:api" as const } },
    ];
    expect(() => assertWorkloadReplicaTopology(services)).toThrow(/sidecar.*api/);
    expect(() =>
      assertWorkloadReplicaTopology([{ ...services[0]!, replicas: 1 }, services[1]!]),
    ).not.toThrow();
  });
  it("normalizes bounded private ports without accepting bindings or configuration injection", () => {
    expect(readComposeExposedPorts([8080, "9000-9002/udp", "8080/tcp"])).toEqual([
      "8080/tcp",
      "9000/udp",
      "9001/udp",
      "9002/udp",
    ]);
    for (const invalid of [
      [0],
      [65536],
      ["1-65535"],
      ["80; proxy_pass attacker"],
      ["0.0.0.0:80:80"],
      ["80/sctp"],
    ])
      expect(() => readComposeExposedPorts(invalid)).toThrow();
  });
});
