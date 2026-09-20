import { describe, expect, test } from "vitest";
import {
  buildPortProbeCommand,
  parseListeningPorts,
  parsePortProbeOutput,
  probePortListeningOnce,
  waitForPortFree,
  waitForPortListening,
  type PortProbeExecutor,
} from "./port-listen";

// Realistic /proc/net/tcp header + rows. The state column (index 3) is 0A for
// LISTEN. local_address is HEXIP:HEXPORT.
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

// IPv4 LISTEN on 0.0.0.0:3000 (0x0BB8).
const IPV4_LISTEN_3000 =
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";

// IPv4 ESTABLISHED (state 01) on 127.0.0.1:5432 (0x1538) — must NOT count.
const IPV4_ESTABLISHED_5432 =
  "   1: 0100007F:1538 0100007F:C1A0 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 20 0 0 10 -1";

const HEADER6 =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

// IPv6-only LISTEN on :::8080 (0x1F90) — the case lsof's IPv4 filter misses.
const IPV6_LISTEN_8080 =
  "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 33333 1 0000000000000000 100 0 0 10 0";

describe("parseListeningPorts", () => {
  test("finds an IPv4 LISTEN port", () => {
    const ports = parseListeningPorts(`${HEADER}\n${IPV4_LISTEN_3000}\n`);
    expect(ports.has(3000)).toBe(true);
    expect(ports.size).toBe(1);
  });

  test("finds an IPv6-only LISTEN port (the union regression lsof missed)", () => {
    // Nothing in tcp, a v6 listener in tcp6 — the union must still catch it.
    const combined = `${HEADER}\n${HEADER6}\n${IPV6_LISTEN_8080}\n`;
    expect(parseListeningPorts(combined).has(8080)).toBe(true);
  });

  test("unions both families", () => {
    const combined = `${HEADER}\n${IPV4_LISTEN_3000}\n${HEADER6}\n${IPV6_LISTEN_8080}\n`;
    const ports = parseListeningPorts(combined);
    expect(ports.has(3000)).toBe(true);
    expect(ports.has(8080)).toBe(true);
  });

  test("excludes non-LISTEN sockets", () => {
    const ports = parseListeningPorts(`${HEADER}\n${IPV4_ESTABLISHED_5432}\n`);
    expect(ports.has(5432)).toBe(false);
    expect(ports.size).toBe(0);
  });

  test("empty / header-only / missing input yields an empty set", () => {
    expect(parseListeningPorts("").size).toBe(0);
    expect(parseListeningPorts(HEADER).size).toBe(0);
    expect(parseListeningPorts("\n\n   \n").size).toBe(0);
  });
});
describe("parsePortProbeOutput", () => {
  test("parses only explicit probe results", () => {
    expect(parsePortProbeOutput("__OPENSHIP_PORT_LISTENING__\n")).toBe(true);
    expect(parsePortProbeOutput("__OPENSHIP_PORT_FREE__\n")).toBe(false);
    expect(parsePortProbeOutput("__OPENSHIP_PORT_UNAVAILABLE__\n")).toBeNull();
  });

  test("treats empty or unexpected output as inconclusive", () => {
    expect(parsePortProbeOutput("")).toBeNull();
    expect(parsePortProbeOutput("13917\n")).toBeNull();
    expect(parsePortProbeOutput("permission denied\n")).toBeNull();
  });
});

describe("buildPortProbeCommand", () => {
  test("generates a guarded lsof and ss fallback", () => {
    const cmd = buildPortProbeCommand(80);
    expect(cmd).toContain("lsof -nP -t -iTCP:80 -sTCP:LISTEN");
    expect(cmd).toContain('ss -tln "sport = :80"');
    expect(cmd).toContain("__OPENSHIP_PORT_FREE__");
    expect(cmd).toContain("__OPENSHIP_PORT_UNAVAILABLE__");
  });

  test("rejects values that are not valid TCP ports before shell interpolation", () => {
    expect(() => buildPortProbeCommand(0)).toThrow(RangeError);
    expect(() => buildPortProbeCommand(65_536)).toThrow(RangeError);
    expect(() => buildPortProbeCommand(Number.NaN)).toThrow(RangeError);
  });
});

/** A stub executor whose exec returns a fixed dump (or throws). */
function stubExecutor(behavior: () => Promise<string>): PortProbeExecutor {
  return { exec: () => behavior() };
}

function fallbackExecutor(output: string): PortProbeExecutor {
  return {
    exec: async (command) => {
      if (command.startsWith("cat /proc/net/")) throw new Error("procfs unavailable");
      return output;
    },
  };
}

describe("waitForPortListening", () => {
  test("returns {listening:true, checked:true} when the port is present", async () => {
    const exec = stubExecutor(async () => `${HEADER}\n${IPV4_LISTEN_3000}\n`);
    expect(await waitForPortListening(exec, 3000, { timeoutMs: 500, intervalMs: 50 })).toEqual({
      listening: true,
      checked: true,
    });
  });

  test("never rejects and returns {checked:false} when every attempt errors", async () => {
    const exec = stubExecutor(async () => {
      throw new Error("no such container");
    });
    const start = Date.now();
    const result = await waitForPortListening(exec, 3000, { timeoutMs: 200, intervalMs: 50 });
    expect(result).toEqual({ listening: false, checked: false });
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("returns {listening:false, checked:true} when the port never appears", async () => {
    // A valid dump that simply doesn't contain the target port.
    const exec = stubExecutor(async () => `${HEADER}\n${IPV4_LISTEN_3000}\n`);
    expect(await waitForPortListening(exec, 9999, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      listening: false,
      checked: true,
    });
  });
  test("handles macOS lsof listening PID output", async () => {
    const exec = fallbackExecutor("__OPENSHIP_PORT_LISTENING__\n");
    expect(await waitForPortListening(exec, 80, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      listening: true,
      checked: true,
    });
  });

  test("handles macOS lsof __FREE__ output", async () => {
    const exec = fallbackExecutor("__OPENSHIP_PORT_FREE__\n");
    expect(await waitForPortListening(exec, 80, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      listening: false,
      checked: true,
    });
  });

  test("treats __UNAVAILABLE__ or missing output as inconclusive", async () => {
    const exec = fallbackExecutor("__OPENSHIP_PORT_UNAVAILABLE__\n");
    expect(await waitForPortListening(exec, 80, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      listening: false,
      checked: false,
    });
  });
});

describe("waitForPortFree", () => {
  test("returns {free:true, checked:true} when __FREE__ is returned", async () => {
    const exec = fallbackExecutor("__OPENSHIP_PORT_FREE__\n");
    expect(await waitForPortFree(exec, 80, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      free: true,
      checked: true,
    });
  });

  test("returns {free:false, checked:true} when port remains occupied via lsof PID", async () => {
    const exec = fallbackExecutor("__OPENSHIP_PORT_LISTENING__\n");
    expect(await waitForPortFree(exec, 80, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      free: false,
      checked: true,
    });
  });

  test("returns {free:false, checked:false} when probe is inconclusive", async () => {
    const exec = fallbackExecutor("__OPENSHIP_PORT_UNAVAILABLE__\n");
    expect(await waitForPortFree(exec, 80, { timeoutMs: 150, intervalMs: 50 })).toEqual({
      free: false,
      checked: false,
    });
  });
});

describe("probePortListeningOnce", () => {
  test("is inconclusive when both procfs address-family reads fail", async () => {
    const executor: PortProbeExecutor = {
      exec: async () => {
        throw new Error("permission denied");
      },
    };

    await expect(probePortListeningOnce(executor, 443)).resolves.toBeNull();
  });

  test("uses the readable family when only the other procfs read fails", async () => {
    const executor: PortProbeExecutor = {
      exec: async (command) => {
        if (command.includes("tcp6")) throw new Error("missing");
        return `${HEADER}\n${IPV4_LISTEN_3000}\n`;
      },
    };

    await expect(probePortListeningOnce(executor, 3000)).resolves.toBe(true);
    await expect(probePortListeningOnce(executor, 9999)).resolves.toBe(false);
  });

  test("uses the portable fallback when procfs is unavailable", async () => {
    await expect(
      probePortListeningOnce(fallbackExecutor("__OPENSHIP_PORT_LISTENING__\n"), 80),
    ).resolves.toBe(true);
    await expect(
      probePortListeningOnce(fallbackExecutor("__OPENSHIP_PORT_FREE__\n"), 80),
    ).resolves.toBe(false);
    await expect(
      probePortListeningOnce(fallbackExecutor("__OPENSHIP_PORT_UNAVAILABLE__\n"), 80),
    ).resolves.toBeNull();
  });
});
