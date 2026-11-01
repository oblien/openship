import { describe, expect, it } from "vitest";
import { buildBaseSshArgs, sshTarget } from "./system-ssh";

const config = { host: "server.example.test", username: "root", port: 22 };

describe("system SSH argument boundary", () => {
  it.each(["-oProxyCommand=id", "host$(id)", "host\ncommand", "host`id`"])("refuses unsafe host and jump-host substitutions: %s", host => {
    expect(() => sshTarget({ ...config, host })).toThrow();
    expect(() => buildBaseSshArgs({ ...config, sshJumpHost: host }, "/tmp/test-master.sock")).toThrow();
  });
  it("refuses username substitutions and invalid ports", () => {
    expect(() => sshTarget({ ...config, username: "root$(id)" })).toThrow();
    expect(() => buildBaseSshArgs({ ...config, port: -1 }, "/tmp/test-master.sock")).toThrow();
    expect(sshTarget({ ...config, host: "2001:db8::1" })).toBe("root@2001:db8::1");
  });
  it.each([
    "-oProxyCommand=touch${IFS}/tmp/not-executed",
    "-o proxycommand=touch${IFS}/tmp/not-executed",
    "-o 'ProxyCommand=echo test'",
    "-oLocalCommand=id -oPermitLocalCommand=yes",
    "-oKnownHostsCommand=id",
    "-oInclude=/tmp/config",
    "-F /tmp/config",
    "-oUserKnownHostsFile=/tmp/overwrite",
    "-oControlPath=/tmp/another-master",
    "-S /tmp/another-master",
    "-E /tmp/overwrite",
    "-L 8080:127.0.0.1:4000",
    "-R 8080:127.0.0.1:4000",
    "-oRemoteCommand=id",
    "-- another-host command",
    "-oIPQoS=throughput another-host command",
  ])("refuses local execution, file access, forwarding and target overrides: %s", (sshArgs) => {
    expect(() => buildBaseSshArgs({ ...config, sshArgs }, "/tmp/test-master.sock")).toThrow();
  });

  it("keeps ordinary SSH connection tuning and the dedicated jump host", () => {
    const args = buildBaseSshArgs({
      ...config,
      sshJumpHost: "deployer@bastion.example.test:2222",
      sshArgs: "-4 -C -o IPQoS=throughput -o 'KexAlgorithms=+diffie-hellman-group14-sha256'",
    }, "/tmp/test-master.sock");
    expect(args).toContain("deployer@bastion.example.test:2222");
    expect(args).toContain("IPQoS=throughput");
    expect(args).toContain("KexAlgorithms=+diffie-hellman-group14-sha256");
    expect(args).toContain("ControlPath=/tmp/test-master.sock");
  });
});
