import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { PassThrough } from "node:stream";
const h = vi.hoisted(() => ({ forwardPort: vi.fn(), acquire: vi.fn() }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { acquire: h.acquire } }));
import { tunnelForward, type ForwardHandle } from "@repo/platform/engine/lib/ssh-tunnel";

const handles: ForwardHandle[] = [];
const sockets: net.Socket[] = [];
const listeners: net.Server[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  h.acquire.mockResolvedValue({ forwardPort: h.forwardPort });
  h.forwardPort.mockImplementation(async () => new PassThrough());
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(handles.splice(0).map(handle => handle.close()));
  await Promise.all(listeners.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function connect(port: number) {
  const socket = net.connect({ host: "127.0.0.1", port });
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

describe("real loopback forwarding sockets", () => {
  it("falls back from an occupied port, forwards data, and closes active clients", async () => {
    const occupied = net.createServer();
    listeners.push(occupied);
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const preferredPort = (occupied.address() as net.AddressInfo).port;
    const handle = await tunnelForward("server", 5432, { preferredPort });
    handles.push(handle);
    expect(handle.localPort).not.toBe(preferredPort);
    const socket = await connect(handle.localPort);
    const data = once(socket, "data");
    socket.write("hello through SSH");
    expect((await data)[0].toString()).toBe("hello through SSH");
    expect(h.forwardPort).toHaveBeenCalledWith("127.0.0.1", 5432);
    expect(handle.activeConnections).toBe(1);
    await handle.close();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(handle.activeConnections).toBe(0);
  });

  it("refuses a new connection after authorization is revoked", async () => {
    let allowed = true;
    const handle = await tunnelForward("server", 5432, { preferredPort: 0, beforeConnect: async () => {
      if (!allowed) throw new Error("revoked");
    } });
    handles.push(handle);
    allowed = false;
    const socket = await connect(handle.localPort);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(h.forwardPort).not.toHaveBeenCalled();
  });

  it("destroys an SSH channel that finishes opening after the listener was closed", async () => {
    let finish!: (remote: PassThrough) => void;
    h.forwardPort.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const handle = await tunnelForward("server", 5432, { preferredPort: 0 });
    handles.push(handle);
    await connect(handle.localPort);
    await vi.waitFor(() => expect(h.forwardPort).toHaveBeenCalledTimes(1));
    await handle.close();
    const remote = new PassThrough();
    finish(remote);
    await vi.waitFor(() => expect(remote.destroyed).toBe(true));
  });

  it("rejects denied access before resolving SSH or binding a port", async () => {
    await expect(tunnelForward("server", 5432, { beforeConnect: async () => { throw new Error("denied"); } })).rejects.toThrow("denied");
    expect(h.acquire).not.toHaveBeenCalled();
  });
});
