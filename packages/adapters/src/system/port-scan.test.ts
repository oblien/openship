import { describe, it, expect } from "vitest";
import {
  parseSsListeners,
  parseProcNetListeners,
  isLoopbackAddress,
  describeService,
  scanPorts,
  type PortScanExecutor,
} from "./port-scan";

describe("isLoopbackAddress", () => {
  it("treats loopback binds as loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("treats wildcard + real interfaces as NOT loopback (→ exposed)", () => {
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("::")).toBe(false);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress("65.109.55.23")).toBe(false);
  });
});

describe("describeService", () => {
  it("labels well-known ports + flags required/sensitive", () => {
    expect(describeService(22)).toMatchObject({ service: "SSH", required: true });
    expect(describeService(443)).toMatchObject({ service: "HTTPS", required: true });
    expect(describeService(6379)).toMatchObject({ service: "Redis", sensitive: true });
    expect(describeService(2375)).toMatchObject({ service: "Docker API (unencrypted)", sensitive: true });
    expect(describeService(49999)).toEqual({ service: null });
  });

  it("attaches service info onto scanned listeners", () => {
    const [redis] = parseSsListeners(`tcp LISTEN 0 511 0.0.0.0:6379 0.0.0.0:* users:(("redis",pid=1,fd=6))`);
    expect(redis).toMatchObject({ service: "Redis", sensitive: true, reachable: null });
  });
});

describe("parseSsListeners", () => {
  it("parses TCP/UDP, both families, classifying exposed vs loopback + owner", () => {
    const out = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      4096   0.0.0.0:22         0.0.0.0:*         users:(("sshd",pid=800,fd=3))
tcp   LISTEN 0      511    127.0.0.1:6379     0.0.0.0:*         users:(("redis-server",pid=901,fd=6))
tcp   LISTEN 0      4096   [::]:22            [::]:*            users:(("sshd",pid=800,fd=4))
tcp   LISTEN 0      128    [::1]:5432         [::]:*            users:(("postgres",pid=1002,fd=7))
udp   UNCONN 0      0      0.0.0.0:68         0.0.0.0:*         users:(("dhclient",pid=700,fd=5))
tcp   ESTAB  0      0      10.0.0.2:51000     1.2.3.4:443       users:(("curl",pid=1,fd=3))`;
    const listeners = parseSsListeners(out);

    // ESTAB row and header dropped; 5 listening sockets kept.
    expect(listeners).toHaveLength(5);

    const ssh4 = listeners.find((l) => l.port === 22 && l.family === "ipv4")!;
    expect(ssh4).toMatchObject({ proto: "tcp", address: "0.0.0.0", exposed: true, pid: 800, process: "sshd" });

    const redis = listeners.find((l) => l.port === 6379)!;
    expect(redis).toMatchObject({ address: "127.0.0.1", exposed: false, process: "redis-server" });

    const pg = listeners.find((l) => l.port === 5432)!;
    expect(pg).toMatchObject({ family: "ipv6", address: "::1", exposed: false });

    const dhcp = listeners.find((l) => l.port === 68)!;
    expect(dhcp).toMatchObject({ proto: "udp", exposed: true });
  });

  it("handles process column absent (non-root ss)", () => {
    const out = `tcp   LISTEN 0      4096   0.0.0.0:8080       0.0.0.0:*`;
    const [l] = parseSsListeners(out);
    expect(l).toMatchObject({ port: 8080, exposed: true, pid: null, process: null });
  });
});

describe("parseProcNetListeners", () => {
  it("decodes /proc hex addresses and classifies, across families + protos", () => {
    // 0.0.0.0:80 (0050) LISTEN; 127.0.0.1:6379 (1911) LISTEN
    const tagged = `##tcp
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 123
   1: 0100007F:18EB 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 456
   2: 0100007F:C1BA 04030201:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 789
##tcp6
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0 0 111
   1: 00000000000000000000000001000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   999 0 222
##udp
   0: 00000000:0044 00000000:0000 07 00000000:00000000 00:00000000 00000000     0 0 333
##udp6`;
    const listeners = parseProcNetListeners(tagged);

    // ESTAB (st 01) tcp row dropped.
    const v4http = listeners.find((l) => l.port === 80)!;
    expect(v4http).toMatchObject({ proto: "tcp", family: "ipv4", address: "0.0.0.0", exposed: true });

    const v4redis = listeners.find((l) => l.port === 6379)!;
    expect(v4redis).toMatchObject({ address: "127.0.0.1", exposed: false });

    const v6ssh = listeners.find((l) => l.port === 22)!;
    expect(v6ssh).toMatchObject({ family: "ipv6", address: "::", exposed: true });

    const v6pg = listeners.find((l) => l.port === 5432)!;
    expect(v6pg).toMatchObject({ family: "ipv6", address: "::1", exposed: false });

    const udp = listeners.find((l) => l.port === 68)!;
    expect(udp).toMatchObject({ proto: "udp", exposed: true });

    expect(listeners.find((l) => l.port === 49594)).toBeUndefined(); // C1BA ESTAB dropped
  });
});

describe("scanPorts", () => {
  const execWith = (map: Record<string, string>): PortScanExecutor => ({
    async exec(cmd: string) {
      for (const [needle, value] of Object.entries(map)) {
        if (cmd.includes(needle)) return value;
      }
      throw new Error("command not found");
    },
  });

  it("prefers ss and returns sorted, counted result", async () => {
    const exec = execWith({
      "ss -tulnp": `tcp LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:* users:(("redis",pid=1,fd=6))
tcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=2,fd=6))`,
    });
    const res = await scanPorts(exec);
    expect(res.source).toBe("ss");
    expect(res.scanned).toBe(true);
    expect(res.totalCount).toBe(2);
    expect(res.exposedCount).toBe(1);
    // exposed sorts first
    expect(res.listeners[0]).toMatchObject({ port: 443, exposed: true });
  });

  it("falls back to procfs when ss is absent", async () => {
    const exec = execWith({
      "/proc/net": `##tcp
   0: 00000000:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1
##tcp6
##udp
##udp6`,
    });
    const res = await scanPorts(exec);
    expect(res.source).toBe("procfs");
    expect(res.scanned).toBe(true);
    expect(res.totalCount).toBe(1);
    expect(res.listeners[0]).toMatchObject({ port: 443, address: "0.0.0.0", exposed: true });
  });

  it("reports scanned:false when every tier is inconclusive", async () => {
    const exec: PortScanExecutor = {
      async exec() {
        throw new Error("executor dead");
      },
    };
    const res = await scanPorts(exec);
    expect(res.scanned).toBe(false);
    expect(res.totalCount).toBe(0);
  });
});
