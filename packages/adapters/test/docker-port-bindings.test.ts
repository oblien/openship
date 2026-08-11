import { describe, expect, it } from "vitest";

import { parsePortBindings } from "../src/runtime/docker";

/**
 * Extra user-declared compose ports (everything but the ONE primary port the edge
 * fronts) flow through parsePortBindings into HostConfig.PortBindings. Its default
 * interface is the last line of defence against a compose service quietly landing
 * on the public network: Docker's own default is all-interfaces, and because Docker
 * publishes via nat-table DNAT (evaluated before the filter INPUT chain) a host
 * ufw/nftables allow-list does NOT block a published port. So a spec that pins no
 * interface must bind loopback, and only an EXPLICIT interface in the spec (incl.
 * "0.0.0.0") may reach the public network.
 */
describe("parsePortBindings — default bind interface", () => {
  it("binds a container-only spec ('3000') to loopback with a random host port", () => {
    const { exposedPorts, portBindings } = parsePortBindings(["3000"]);
    expect(exposedPorts).toEqual({ "3000/tcp": {} });
    expect(portBindings["3000/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "" }]);
  });

  it("binds a 2-part spec ('8080:3000') to loopback on the requested host port", () => {
    const { portBindings } = parsePortBindings(["8080:3000"]);
    expect(portBindings["3000/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "8080" }]);
  });

  it("preserves an explicit loopback interface ('127.0.0.1:8080:80')", () => {
    const { portBindings } = parsePortBindings(["127.0.0.1:8080:80"]);
    expect(portBindings["80/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "8080" }]);
  });

  it("preserves an explicit public interface ('0.0.0.0:8080:80') — publishing is opt-in", () => {
    // The escape hatch: writing 0.0.0.0 into the spec is a deliberate choice and is
    // honoured verbatim, so a service that genuinely needs to be public still can be.
    const { portBindings } = parsePortBindings(["0.0.0.0:8080:80"]);
    expect(portBindings["80/tcp"]).toEqual([{ HostIp: "0.0.0.0", HostPort: "8080" }]);
  });

  it("preserves an explicit LAN interface ('192.168.1.10:8080:80')", () => {
    const { portBindings } = parsePortBindings(["192.168.1.10:8080:80"]);
    expect(portBindings["80/tcp"]).toEqual([{ HostIp: "192.168.1.10", HostPort: "8080" }]);
  });
});

describe("parsePortBindings — protocol handling", () => {
  it("carries a /udp suffix onto the key and still defaults to loopback", () => {
    const { exposedPorts, portBindings } = parsePortBindings(["53:53/udp"]);
    expect(exposedPorts).toEqual({ "53/udp": {} });
    expect(portBindings["53/udp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "53" }]);
  });

  it("carries a /sctp suffix on a container-only spec", () => {
    const { exposedPorts, portBindings } = parsePortBindings(["9000/sctp"]);
    expect(exposedPorts).toEqual({ "9000/sctp": {} });
    expect(portBindings["9000/sctp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "" }]);
  });

  it("treats an unknown/absent protocol as tcp", () => {
    expect(parsePortBindings(["8080:80/http"]).portBindings["80/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "8080" },
    ]);
    expect(parsePortBindings(["8080:80"]).portBindings["80/tcp"]).toBeDefined();
  });

  it("keeps a /udp suffix on an explicit-interface 3-part spec", () => {
    const { portBindings } = parsePortBindings(["0.0.0.0:5514:514/udp"]);
    expect(portBindings["514/udp"]).toEqual([{ HostIp: "0.0.0.0", HostPort: "5514" }]);
  });
});
