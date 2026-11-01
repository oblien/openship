import { createServer as createTlsServer } from "node:tls";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestCert } from "./proxy/test-certs";
import { probePublicTlsCertificate } from "./tls-probe";

const h = vi.hoisted(() => ({
  port: 0,
  ca: undefined as string | undefined,
  servername: "",
  resolve: vi.fn(async () => ({ ip: "127.0.0.1", family: 4 })),
}));
vi.mock("./outbound-target", () => ({ resolvePinnedHost: h.resolve }));
vi.mock("node:tls", async (original) => {
  const tls = await original<typeof import("node:tls")>();
  return {
    ...tls,
    connect: (options: import("node:tls").ConnectionOptions) => {
      h.servername = options.servername!;
      return tls.connect({ ...options, port: h.port, ca: h.ca });
    },
  };
});

let server: Server | undefined;
const sockets = new Set<Socket>();
async function listen(names: string[] = ["www.example.com"], trusted = true, stall = false) {
  const cert = makeTestCert(names);
  h.ca = trusted ? cert.certPem : undefined;
  server = stall ? createServer() : createTlsServer({ cert: cert.certPem, key: cert.keyPem });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  h.port = (server.address() as { port: number }).port;
}
beforeEach(() => {
  h.resolve.mockReset().mockResolvedValue({ ip: "127.0.0.1", family: 4 });
  h.servername = "";
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("public TLS observation", () => {
  it("uses the requested SNI and checks the real trusted peer certificate", async () => {
    await listen();
    const observed = await probePublicTlsCertificate("www.example.com");
    expect(observed).toMatchObject({ verified: true, reason: "issued" });
    expect(Date.parse(observed.expiresAt)).toBeGreaterThan(Date.now());
    expect(h.servername).toBe("www.example.com");
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith(
      "www.example.com",
      false,
      expect.any(AbortSignal),
    );
  });

  it("rejects the real apex certificate when connecting as www", async () => {
    await listen(["example.com"]);
    expect(await probePublicTlsCertificate("www.example.com")).toMatchObject({
      verified: false,
      reason: "edge_invalid",
    });
  });

  it("rejects an untrusted chain even when the name matches", async () => {
    await listen(["www.example.com"], false);
    expect(await probePublicTlsCertificate("www.example.com")).toMatchObject({
      verified: false,
      reason: "edge_invalid",
    });
  });

  it("checks expiry independently of provider metadata", async () => {
    await listen();
    const future = Date.now() + 60 * 86_400_000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    expect(await probePublicTlsCertificate("www.example.com")).toMatchObject({
      verified: false,
      reason: "edge_invalid",
    });
  });

  it("bounds a stalled handshake and reports an unknown observation", async () => {
    await listen(undefined, true, true);
    const start = Date.now();
    expect(await probePublicTlsCertificate("www.example.com", 50)).toMatchObject({
      reason: "read_error",
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("does not dial when DNS or public-address validation fails", async () => {
    h.resolve.mockRejectedValue(new Error("private address blocked"));
    expect(await probePublicTlsCertificate("www.example.com")).toMatchObject({
      reason: "read_error",
    });
    expect(h.servername).toBe("");
  });

  it("does not dial a literal wildcard or malformed hostname", async () => {
    for (const host of ["*.example.com", "example.com:22", "user@example.com", "example.com/path"])
      expect(await probePublicTlsCertificate(host)).toMatchObject({ reason: "read_error" });
    expect(h.resolve).not.toHaveBeenCalled();
  });
});
